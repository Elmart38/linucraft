import { joinPath } from "./vfs.js";
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

function basename(p) {
  const segs = p.split("/").filter((s) => s.length > 0);
  return segs.length ? segs[segs.length - 1] : p;
}

export function createKernel({ vfs, tty, programs }) {
  const fileBackend = createFileBackend(vfs);
  const procs = new Map();
  let nextPid = 1;
  let ticks = 0;

  const kernel = {
    vfs,
    tty,
    get ticks() {
      return ticks;
    },

    // Démarre le processus initial (ex. /bin/sh) attaché au TTY.
    start(path, argv = [], { cwd } = {}) {
      const ttyOfd = { backend: tty };
      return _create(path, argv, {
        ppid: 0,
        cwd: cwd ? cwd.slice() : vfs.homeSegments.slice(),
        env: { HOME: joinPath(vfs.homeSegments), USER: vfs.user, PATH: "/bin", PWD: "" },
        fds: [ttyOfd, ttyOfd, ttyOfd],
      });
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

    // Un battement de noyau : fait avancer les processus dans la limite du budget.
    tick() {
      ticks++;
      const budget = { n: MAX_STEPS_PER_TICK };
      for (const proc of [...procs.values()]) {
        if (proc.state === "zombie") continue;
        advance(proc, budget);
        if (budget.n <= 0) break;
      }
    },
  };

  // --- Création d'un processus ---------------------------------------------
  function _create(path, argv, { ppid, cwd, env, fds }) {
    const fn = programs[basename(path)];
    const proc = {
      pid: nextPid++,
      ppid,
      path,
      argv: [path, ...argv],
      cwd,
      env,
      fds, // tableau d'OFD (index = fd local)
      state: "ready",
      gen: null,
      resumeVal: undefined,
      pending: null, // syscall en attente (processus BLOCKED)
      exitCode: 0,
      wakeTick: null, // pour sleep()
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
    // Fermer tous les descripteurs (libère les tubes → EOF pour les lecteurs).
    for (const ofd of proc.fds) if (ofd && ofd.backend.close) ofd.backend.close(ofd);
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
        if (!vfs.isDir(segs)) {
          const n = vfs.getNode(segs);
          return { value: n ? E.NOTDIR : E.NOENT };
        }
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

      case "readdir": {
        const segs = vfs.resolve(proc.cwd, sc.path);
        const abs = joinPath(segs);
        if (abs === "/proc")
          return { value: kernel.snapshot().map((p) => String(p.pid)).concat(["uptime"]) };
        const list = vfs.readdir(segs);
        return { value: list === null ? E.NOTDIR : list };
      }

      case "mkdir": {
        const r = vfs.createDir(vfs.resolve(proc.cwd, sc.path));
        return { value: r.err ? errnoFromVfs(r.err) : 0 };
      }

      case "unlink": {
        const r = vfs.remove(vfs.resolve(proc.cwd, sc.path), sc.recursive);
        return { value: r.err ? errnoFromVfs(r.err) : 0 };
      }

      case "spawn": {
        const childFds = (sc.opts.fds || [0, 1, 2]).map((i) => proc.fds[i] ?? null);
        // Chaque fd hérité est une référence de plus sur l'OFD (refcount tubes).
        for (const ofd of childFds) if (ofd && ofd.backend.ref) ofd.backend.ref(ofd);
        return {
          value: _create(sc.path, sc.argv, {
            ppid: proc.pid,
            cwd: proc.cwd.slice(),
            env: { ...proc.env },
            fds: childFds,
          }),
        };
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

      case "yield":
        return { value: 0 };

      case "exit":
        return { exit: sc.code | 0 };

      case "ps":
        return { value: kernel.snapshot() };

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
      const fd = allocFd(proc);
      proc.fds[fd] = { backend: fileBackend, mode: "r", segments: segs, buf: node.d, pos: 0 };
      return fd;
    }
    if (mode === "w" || mode === "a") {
      if (segs.length === 0) return E.ISDIR;
      const parent = vfs.getNode(segs.slice(0, -1));
      if (!parent) return E.NOENT;
      if (parent.t !== "d") return E.NOTDIR;
      const existing = parent.c[segs[segs.length - 1]];
      if (existing && existing.t === "d") return E.ISDIR;
      const fd = allocFd(proc);
      proc.fds[fd] = { backend: fileBackend, mode, segments: segs, wbuf: "" };
      return fd;
    }
    return E.INVAL;
  }

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
