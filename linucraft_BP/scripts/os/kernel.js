import { joinPath, modeOf, uidOf, gidOf } from "./vfs.js";
import { E, errnoFromVfs } from "./errno.js";
import {
  createFileBackend,
  memReadBackend,
  nullBackend,
  zeroBackend,
  randomBackend,
  createPipe,
} from "./backends.js";
import { makeCtx } from "./stdlib.js";

// ---------------------------------------------------------------------------
// Le NOYAU : table de processus, ordonnanceur coopératif, dispatch des syscalls.
//
// Idée maîtresse : un processus = un générateur JS. Chaque `yield SYS.*` est à
// la fois un appel système ET un point de préemption. Le noyau bat au rythme
// des ticks (kernel.tick()) et plafonne le travail par tick (budget), ce qui
// garantit qu'aucun programme — même un `while(true)` — ne gèle le jeu.
// ---------------------------------------------------------------------------

const MAX_STEPS_PER_TICK = 2000; // budget anti-watchdog (à calibrer en jeu)
const MAX_MS_PER_TICK = 6; // garde temporel : un tick de jeu dure 50 ms

function basename(p) {
  const segs = p.split("/").filter((s) => s.length > 0);
  return segs.length ? segs[segs.length - 1] : p;
}

export function createKernel({ vfs, tty, programs }) {
  const fileBackend = createFileBackend(vfs);
  const procs = new Map();
  let nextPid = 1;
  let ticks = 0;
  let rrCursor = 0; // rotation round-robin de l'ordre d'ordonnancement
  let hostSeq = 0; // ids des requêtes hôte
  const hostReqs = new Map(); // id -> requête hôte non complétée (voir case "host")

  const kernel = {
    vfs,
    tty,
    initPid: 0,
    get ticks() {
      return ticks;
    },

    // Démarre le processus initial (ex. /bin/sh) attaché au TTY.
    start(path, argv = [], { cwd } = {}) {
      const ttyOfd = { backend: tty };
      const uid = vfs.USER_UID ?? 1000;
      const pid = _create(path, argv, {
        ppid: 0,
        uid,
        gid: uid,
        user: vfs.user,
        cwd: cwd ? cwd.slice() : vfs.homeSegments.slice(),
        env: { HOME: joinPath(vfs.homeSegments), USER: vfs.user, UID: String(uid), PATH: "/bin", PWD: "" },
        fds: [ttyOfd, ttyOfd, ttyOfd],
      });
      if (!kernel.initPid) kernel.initPid = pid;
      return pid;
    },

    // ^C : tue le pipeline d'avant-plan (descendants non-`&` du shell de login).
    interrupt() {
      const doomed = [];
      const walk = (ppid) => {
        for (const p of procs.values())
          if (p.ppid === ppid && !p.bg && p.state !== "zombie") {
            doomed.push(p);
            walk(p.pid);
          }
      };
      walk(kernel.initPid);
      for (const p of doomed) finish(p, 130); // 128 + SIGINT
    },

    // Reste-t-il des processus vivants ?
    alive() {
      for (const p of procs.values()) if (p.state !== "zombie") return true;
      return false;
    },

    snapshot() {
      return [...procs.values()].map((p) => ({
        pid: p.pid,
        ppid: p.ppid,
        state: p.state,
        cmd: p.argv.join(" "),
      }));
    },

    // --- Canal hôte -------------------------------------------------------
    // `yield SYS.host(kind, payload)` bloque le processus jusqu'à ce que la
    // couche plateforme (terminal.js en jeu, un stub en test) appelle
    // completeHostCall(id, result). Le noyau transporte payload et result
    // verbatim : le contrat (pages, saved, error…) appartient aux deux bouts.
    onHostCall: null, // callback (req) => void, câblé comme tty.wantInput
    hostCalls() {
      return [...hostReqs.values()]
        .filter((r) => !r.done)
        .map(({ id, pid, kind, payload }) => ({ id, pid, kind, payload }));
    },
    completeHostCall(id, result) {
      const req = hostReqs.get(id);
      if (!req || req.done) return false;
      req.done = true;
      req.result = result;
      return true;
    },

    // Un battement de noyau : fait avancer les processus dans la limite du
    // budget (pas ET temps réel — un `while(true)` interprété rend chaque pas
    // coûteux, seul le temps protège vraiment du watchdog). Le budget de pas
    // est partagé équitablement pour qu'une boucle n'affame pas les autres.
    tick() {
      ticks++;
      const t0 = Date.now();
      const alive = [...procs.values()].filter((p) => p.state !== "zombie");
      if (alive.length === 0) return;
      const share = Math.max(16, Math.ceil(MAX_STEPS_PER_TICK / alive.length));
      // Rotation round-robin : on ne commence pas toujours par le même processus.
      // Sinon le garde temporel (break sur MAX_MS_PER_TICK) couperait toujours la
      // fin de la liste → un `while(true)` en tête affamerait l'avant-plan.
      const start = rrCursor % alive.length;
      for (let k = 0; k < alive.length; k++) {
        const proc = alive[(start + k) % alive.length];
        advance(proc, { n: share, t0 });
        if (Date.now() - t0 > MAX_MS_PER_TICK) break;
      }
      rrCursor = (rrCursor + 1) % alive.length;
    },
  };

  // --- Création d'un processus ---------------------------------------------
  function _create(path, argv, { ppid, cwd, env, fds, uid = 1000, gid = 1000, user = "user", bg = false }) {
    const fn = programs[basename(path)];
    const proc = {
      pid: nextPid++,
      ppid,
      path,
      argv: [path, ...argv],
      cwd,
      env,
      fds, // tableau d'OFD (index = fd local)
      uid,
      gid,
      user,
      bg, // lancé avec `&` : épargné par ^C
      state: "ready",
      gen: null,
      resumeVal: undefined,
      pending: null, // syscall en attente (processus BLOCKED)
      exitCode: 0,
      wakeTick: null, // pour sleep()
      hostReq: null, // requête hôte en attente (voir case "host")
    };
    procs.set(proc.pid, proc);
    if (!fn) {
      // Programme introuvable : le « processus » naît mort avec le code 127,
      // comme sous Unix. spawn renvoie quand même son pid (wait → 127).
      writeFd(proc, 2, `${basename(path)}: command not found\n`);
      finish(proc, 127);
      return proc.pid;
    }
    proc.gen = fn(makeCtx(proc));
    return proc.pid;
  }

  // --- Boucle d'avancement d'un processus ----------------------------------
  function advance(proc, budget) {
    while (budget.n > 0) {
      budget.n--;
      // Garde temporel (vérifié par paquets de 32 pas pour rester bon marché).
      if ((budget.n & 31) === 0 && Date.now() - budget.t0 > MAX_MS_PER_TICK) {
        budget.n = 0;
        return;
      }

      // 1) Si le processus était bloqué, on ré-essaie son syscall en attente.
      if (proc.pending) {
        const r = dispatch(proc, proc.pending);
        if (r.block) {
          proc.state = "blocked";
          return; // toujours bloqué : on rendra la main au prochain tick
        }
        if (r.exit !== undefined) return finish(proc, r.exit);
        proc.pending = null;
        proc.resumeVal = r.value;
      }

      // 2) On reprend le générateur avec la dernière valeur résolue.
      let res;
      try {
        res = proc.gen.next(proc.resumeVal);
      } catch (e) {
        writeFd(proc, 2, `${basename(proc.path)}: ${e && e.message ? e.message : e}\n`);
        return finish(proc, 1);
      }
      if (res.done) return finish(proc, typeof res.value === "number" ? res.value : 0);

      // 3) On exécute le syscall demandé.
      const r = dispatch(proc, res.value);
      if (r.exit !== undefined) return finish(proc, r.exit);
      if (r.block) {
        proc.pending = res.value;
        proc.state = "blocked";
        return;
      }
      proc.resumeVal = r.value;
      proc.state = "ready";
    }
    // Budget épuisé : le processus reste prêt pour le prochain tick.
  }

  function finish(proc, code) {
    if (proc.state === "zombie") return;
    proc.exitCode = code;
    proc.state = "zombie";
    // Une requête hôte en attente meurt avec le processus (kill pendant nano) :
    // completeHostCall renverra false et la plateforme fera son ménage.
    if (proc.hostReq) {
      hostReqs.delete(proc.hostReq.id);
      proc.hostReq = null;
    }
    // Fermer tous les descripteurs (libère les tubes → EOF pour les lecteurs).
    for (const ofd of proc.fds) if (ofd && ofd.backend.close) ofd.backend.close(ofd);
    proc.fds = [];
    // Ses enfants deviennent orphelins ; un zombie sans parent est purgé direct.
    for (const p of procs.values()) if (p.ppid === proc.pid) p.ppid = 0;
    if (!procs.has(proc.ppid)) procs.delete(proc.pid);
  }

  // --- Écriture interne sur un fd (erreurs noyau, programme introuvable) ----
  function writeFd(proc, fd, text) {
    const ofd = proc.fds[fd];
    if (ofd && ofd.backend.write) ofd.backend.write(ofd, text);
  }

  function allocFd(proc) {
    for (let i = 0; i < proc.fds.length; i++) if (!proc.fds[i]) return i;
    proc.fds.push(null);
    return proc.fds.length - 1;
  }

  // Le processus a-t-il le droit `need` ('r'|'w'|'x') sur ce noeud ?
  // root (uid 0) passe partout. Modèle rwx propriétaire/groupe/autres.
  function permit(proc, node, need) {
    if (proc.uid === 0) return true;
    const mode = modeOf(node);
    let bits;
    if (uidOf(node) === proc.uid) bits = (mode >> 6) & 7;
    else if (gidOf(node) === proc.gid) bits = (mode >> 3) & 7;
    else bits = mode & 7;
    const want = need === "r" ? 4 : need === "w" ? 2 : 1;
    return (bits & want) === want;
  }

  // --- Dispatch des appels système -----------------------------------------
  // Renvoie { value } (résolu), { block:true } (bloque), ou { exit:code }.
  function dispatch(proc, sc) {
    switch (sc.sys) {
      case "getpid":
        return { value: proc.pid };

      case "getcwd":
        return { value: joinPath(proc.cwd) };

      case "chdir": {
        const segs = vfs.resolve(proc.cwd, sc.path);
        const node = vfs.getNode(segs);
        if (!node) return { value: E.NOENT };
        if (node.t !== "d") return { value: E.NOTDIR };
        if (!permit(proc, node, "x")) return { value: E.ACCES };
        proc.cwd = segs;
        proc.env.PWD = joinPath(segs);
        return { value: 0 };
      }

      case "getenv":
        return { value: proc.env[sc.name] ?? null };
      case "setenv":
        if (sc.value === undefined || sc.value === null) delete proc.env[sc.name];
        else proc.env[sc.name] = sc.value;
        return { value: 0 };
      case "environ":
        return { value: { ...proc.env } };

      case "open":
        return { value: doOpen(proc, sc.path, sc.mode) };

      case "read": {
        const ofd = proc.fds[sc.fd];
        if (!ofd) return { value: E.BADF };
        const r = ofd.backend.read(ofd, sc.n);
        if (r.block) return { block: true };
        if (r.eof) return { value: null };
        if (r.err) return { value: r.err };
        return { value: r.data };
      }

      case "write": {
        const ofd = proc.fds[sc.fd];
        if (!ofd) return { value: E.BADF };
        const r = ofd.backend.write(ofd, sc.data);
        if (r.block) return { block: true };
        if (r.err) return { value: r.err };
        return { value: r.n };
      }

      case "close": {
        const ofd = proc.fds[sc.fd];
        if (!ofd) return { value: E.BADF };
        if (ofd.backend.close) ofd.backend.close(ofd);
        proc.fds[sc.fd] = null;
        return { value: 0 };
      }

      case "dup2": {
        const ofd = proc.fds[sc.oldfd];
        if (!ofd) return { value: E.BADF };
        const prev = proc.fds[sc.newfd];
        if (prev && prev.backend.close) prev.backend.close(prev);
        proc.fds[sc.newfd] = ofd;
        if (ofd.backend.ref) ofd.backend.ref(ofd); // un fd de plus pointe dessus
        return { value: sc.newfd };
      }

      case "pipe": {
        const { readEnd, writeEnd } = createPipe();
        const rfd = allocFd(proc);
        proc.fds[rfd] = { backend: readEnd };
        const wfd = allocFd(proc);
        proc.fds[wfd] = { backend: writeEnd };
        return { value: [rfd, wfd] };
      }

      case "stat": {
        const abs = joinPath(vfs.resolve(proc.cwd, sc.path));
        if (abs.startsWith("/dev/") || abs.startsWith("/proc"))
          return { value: { type: "f", size: 0 } };
        return { value: vfs.stat(vfs.resolve(proc.cwd, sc.path)) };
      }

      case "access": {
        // Teste un droit (r|w|x) sans ouvrir ni créer : mêmes règles que
        // doOpen/permit. Utilisé par nano pour vérifier AVANT l'édition.
        const segs = vfs.resolve(proc.cwd, sc.path);
        const abs = joinPath(segs);
        if (abs.startsWith("/dev/")) return { value: 0 };
        if (abs.startsWith("/proc")) return { value: sc.need === "r" ? 0 : E.ACCES };
        const node = vfs.getNode(segs);
        if (!node) return { value: E.NOENT };
        return { value: permit(proc, node, sc.need) ? 0 : E.ACCES };
      }

      case "readdir": {
        const segs = vfs.resolve(proc.cwd, sc.path);
        const abs = joinPath(segs);
        if (abs === "/proc")
          return { value: kernel.snapshot().map((p) => String(p.pid)).concat(["uptime"]) };
        const node = vfs.getNode(segs);
        if (!node) return { value: E.NOENT };
        if (node.t !== "d") return { value: E.NOTDIR };
        if (!permit(proc, node, "r")) return { value: E.ACCES };
        return { value: Object.keys(node.c).sort() };
      }

      case "mkdir": {
        const segs = vfs.resolve(proc.cwd, sc.path);
        const parent = vfs.getNode(segs.slice(0, -1));
        if (!parent || parent.t !== "d") return { value: E.NOENT };
        if (!permit(proc, parent, "w")) return { value: E.ACCES };
        const r = vfs.createDir(segs, { u: proc.uid, g: proc.gid, mt: ticks });
        return { value: r.err ? errnoFromVfs(r.err) : 0 };
      }

      case "unlink": {
        const segs = vfs.resolve(proc.cwd, sc.path);
        const parent = vfs.getNode(segs.slice(0, -1));
        if (!parent || parent.t !== "d") return { value: E.NOENT };
        if (!permit(proc, parent, "w")) return { value: E.ACCES };
        const r = vfs.remove(segs, sc.recursive);
        return { value: r.err ? errnoFromVfs(r.err) : 0 };
      }

      case "spawn": {
        const childFds = (sc.opts.fds || [0, 1, 2]).map((i) => proc.fds[i] ?? null);
        // Chaque fd hérité est une référence de plus sur l'OFD (refcount tubes).
        for (const ofd of childFds) if (ofd && ofd.backend.ref) ofd.backend.ref(ofd);
        // sudo : un processus peut être lancé sous une autre identité (jeu solo).
        const uid = sc.opts.uid != null ? sc.opts.uid : proc.uid;
        const gid = sc.opts.gid != null ? sc.opts.gid : proc.gid;
        const user = sc.opts.user != null ? sc.opts.user : uid === 0 ? "root" : proc.user;
        const env = { ...proc.env, UID: String(uid) };
        if (uid === 0) env.USER = "root";
        if (sc.opts.env) Object.assign(env, sc.opts.env); // su/login : HOME, USER…
        const cwd = sc.opts.cwd ? vfs.resolve(proc.cwd, sc.opts.cwd) : proc.cwd.slice();
        return {
          value: _create(sc.path, sc.argv, {
            ppid: proc.pid,
            cwd,
            env,
            fds: childFds,
            uid,
            gid,
            user,
            bg: !!sc.opts.bg,
          }),
        };
      }

      case "kill": {
        const target = procs.get(sc.pid | 0);
        if (!target || target.state === "zombie") return { value: E.SRCH };
        if (proc.uid !== 0 && proc.uid !== target.uid) return { value: E.PERM };
        finish(target, 143); // 128 + SIGTERM
        procs.delete(target.pid); // retire vraiment le processus : aucun zombie ne traîne
        return { value: 0 };
      }

      case "wait": {
        let child = null;
        for (const p of procs.values()) {
          if (p.ppid !== proc.pid) continue;
          if (sc.pid >= 0 && p.pid !== sc.pid) continue;
          if (p.state === "zombie") {
            child = p;
            break;
          }
        }
        if (child) {
          procs.delete(child.pid);
          return { value: child.exitCode };
        }
        // A-t-il encore des enfants vivants à attendre ?
        let hasChild = false;
        for (const p of procs.values())
          if (p.ppid === proc.pid && (sc.pid < 0 || p.pid === sc.pid)) hasChild = true;
        if (!hasChild) return { value: -10 }; // ECHILD
        return { block: true };
      }

      case "sleep": {
        if (proc.wakeTick === null) proc.wakeTick = ticks + sc.ticks;
        if (ticks >= proc.wakeTick) {
          proc.wakeTick = null;
          return { value: 0 };
        }
        return { block: true };
      }

      case "host": {
        // Requête à la couche plateforme : créée une seule fois (le descripteur
        // en attente est re-dispatché à chaque tick, comme sleep), puis on
        // bloque jusqu'à completeHostCall. Une complétion synchrone dans le
        // callback (stub de test) résout sans jamais bloquer.
        if (!proc.hostReq) {
          const req = { id: ++hostSeq, pid: proc.pid, kind: sc.kind, payload: sc.payload, done: false, result: undefined };
          proc.hostReq = req;
          hostReqs.set(req.id, req);
          if (kernel.onHostCall) {
            try {
              kernel.onHostCall({ id: req.id, pid: req.pid, kind: req.kind, payload: req.payload });
            } catch (e) {
              // Un plantage de la plateforme ne doit pas paniquer le noyau.
              kernel.completeHostCall(req.id, { error: `hôte: ${e && e.message ? e.message : e}` });
            }
          }
        }
        const req = proc.hostReq;
        if (req.done) {
          proc.hostReq = null;
          hostReqs.delete(req.id);
          return { value: req.result };
        }
        return { block: true };
      }

      case "yield":
        return { value: 0 };

      case "exit":
        return { exit: sc.code | 0 };

      case "ps":
        return { value: kernel.snapshot() };

      case "hasProgram":
        return { value: !!programs[basename(sc.name)] };

      case "listPrograms":
        return { value: Object.keys(programs) };

      case "usage":
        return { value: vfs.usage() };

      case "getuid":
        return { value: proc.uid };
      case "getgid":
        return { value: proc.gid };

      case "setuid": {
        // Jeu solo : su/sudo sont autorisés sans mot de passe.
        proc.uid = sc.uid | 0;
        proc.gid = sc.uid | 0;
        if (sc.user) proc.user = sc.user;
        else proc.user = sc.uid === 0 ? "root" : proc.user;
        proc.env.UID = String(proc.uid);
        proc.env.USER = proc.user;
        return { value: 0 };
      }

      case "lstat": {
        const abs = joinPath(vfs.resolve(proc.cwd, sc.path));
        if (abs.startsWith("/dev/") || abs.startsWith("/proc"))
          return { value: { type: "f", size: 0, mode: 0o644, uid: 0, gid: 0, mtime: 0 } };
        return { value: vfs.lstat(vfs.resolve(proc.cwd, sc.path)) };
      }

      case "chmod": {
        const segs = vfs.resolve(proc.cwd, sc.path);
        const node = vfs.getNode(segs, false);
        if (!node) return { value: E.NOENT };
        if (proc.uid !== 0 && proc.uid !== uidOf(node)) return { value: E.PERM };
        vfs.setMeta(segs, { mode: sc.mode & 0o777 });
        return { value: 0 };
      }

      case "chown": {
        if (proc.uid !== 0) return { value: E.PERM }; // seul root change de propriétaire
        const segs = vfs.resolve(proc.cwd, sc.path);
        if (!vfs.getNode(segs, false)) return { value: E.NOENT };
        vfs.setMeta(segs, { uid: sc.uid, gid: sc.gid != null ? sc.gid : sc.uid });
        return { value: 0 };
      }

      case "symlink": {
        const segs = vfs.resolve(proc.cwd, sc.path);
        const parent = vfs.getNode(segs.slice(0, -1));
        if (!parent || parent.t !== "d") return { value: E.NOENT };
        if (!permit(proc, parent, "w")) return { value: E.ACCES };
        const r = vfs.symlink(segs, sc.target, { u: proc.uid, g: proc.gid, mt: ticks });
        return { value: r.err ? errnoFromVfs(r.err) : 0 };
      }

      default:
        return { value: E.INVAL };
    }
  }

  // --- open : routage device / proc / fichier VFS --------------------------
  function doOpen(proc, path, mode) {
    const segs = vfs.resolve(proc.cwd, path);
    const abs = joinPath(segs);

    // Périphériques /dev
    let devBackend = null;
    if (abs === "/dev/null") devBackend = nullBackend;
    else if (abs === "/dev/zero") devBackend = zeroBackend;
    else if (abs === "/dev/random" || abs === "/dev/urandom") devBackend = randomBackend;
    else if (abs === "/dev/tty" || abs === "/dev/console") devBackend = tty;
    if (devBackend) {
      const fd = allocFd(proc);
      proc.fds[fd] = { backend: devBackend };
      return fd;
    }

    // /proc en lecture seule (généré)
    if (abs === "/proc" || abs.startsWith("/proc/")) {
      const content = procContent(abs);
      if (content === null) return E.NOENT;
      const fd = allocFd(proc);
      proc.fds[fd] = { backend: memReadBackend, buf: content, pos: 0 };
      return fd;
    }

    // Fichier régulier
    if (mode === "r") {
      const node = vfs.getNode(segs);
      if (!node) return E.NOENT;
      if (node.t === "d") return E.ISDIR;
      if (!permit(proc, node, "r")) return E.ACCES;
      const fd = allocFd(proc);
      proc.fds[fd] = { backend: fileBackend, mode: "r", segments: segs, buf: node.d, pos: 0 };
      return fd;
    }
    if (mode === "w" || mode === "a") {
      if (segs.length === 0) return E.ISDIR;
      const parent = vfs.getNode(segs.slice(0, -1));
      if (!parent) return E.NOENT;
      if (parent.t !== "d") return E.NOTDIR;
      const existing = vfs.getNode(segs);
      if (existing && existing.t === "d") return E.ISDIR;
      if (existing) { if (!permit(proc, existing, "w")) return E.ACCES; }
      else if (!permit(proc, parent, "w")) return E.ACCES;
      const fd = allocFd(proc);
      proc.fds[fd] = {
        backend: fileBackend, mode, segments: segs, wbuf: "",
        meta: { u: proc.uid, g: proc.gid, mt: ticks },
      };
      return fd;
    }
    return E.INVAL;
  }

  // La discipline de ligne du TTY déclenche ^C ici.
  tty.onInterrupt = () => kernel.interrupt();

  // Contenu généré de /proc (lecture seule).
  function procContent(abs) {
    if (abs === "/proc/uptime") return `${ticks}\n`;
    const m = abs.match(/^\/proc\/(\d+)\/(\w+)$/);
    if (m) {
      const p = procs.get(Number(m[1]));
      if (!p) return null;
      if (m[2] === "cmdline") return p.argv.join("\0") + "\n";
      if (m[2] === "status")
        return `Pid:\t${p.pid}\nPPid:\t${p.ppid}\nState:\t${p.state}\nCmd:\t${p.argv.join(" ")}\n`;
    }
    return null;
  }

  return kernel;
}
