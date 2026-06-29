import { SYS } from "./syscalls.js";
import { strerror } from "./errno.js";

// ---------------------------------------------------------------------------
// Bibliothèque standard « façon Node », réimplémentée AU-DESSUS des appels
// système. C'est ce que le propriétaire appelait « recoder une partie de
// node.js en JS » : process / fs / path / console, fournis aux programmes.
//
// Convention : toute fonction qui touche au noyau est un GÉNÉRATEUR, appelé par
// le programme via `yield*` (car `yield` doit traverser la pile d'appels) :
//   yield* ctx.console.log("salut");
//   const txt = yield* ctx.fs.readFile("/etc/motd");
// Les fonctions pures (path.*) sont des fonctions normales.
// ---------------------------------------------------------------------------

// --- path : pur, aucun syscall ---------------------------------------------
export const path = {
  normalize(p) {
    const abs = p.startsWith("/");
    const out = [];
    for (const seg of p.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (out.length && out[out.length - 1] !== "..") out.pop();
        else if (!abs) out.push("..");
      } else out.push(seg);
    }
    return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
  },
  join(...parts) {
    return path.normalize(parts.filter((p) => p && p.length).join("/"));
  },
  basename(p) {
    const segs = p.split("/").filter((s) => s.length);
    return segs.length ? segs[segs.length - 1] : "/";
  },
  dirname(p) {
    const segs = p.split("/").filter((s) => s.length);
    segs.pop();
    return p.startsWith("/") ? "/" + segs.join("/") : segs.join("/") || ".";
  },
  extname(p) {
    const b = path.basename(p);
    const i = b.lastIndexOf(".");
    return i > 0 ? b.slice(i) : "";
  },
};

function fmt(x) {
  if (typeof x === "string") return x;
  if (x === null) return "null";
  if (x === undefined) return "undefined";
  if (typeof x === "object") {
    try {
      return JSON.stringify(x);
    } catch {
      return String(x);
    }
  }
  return String(x);
}

// --- Construction du contexte d'un processus -------------------------------
export function makeCtx(proc) {
  // Helpers d'écriture bruts (générateurs).
  function* write(fd, s) {
    return yield SYS.write(fd, s);
  }
  function* out(s) {
    return yield SYS.write(1, s);
  }
  function* err(s) {
    return yield SYS.write(2, s);
  }

  // Lit une ligne sur stdin (sans le \n final). Renvoie null en fin de flux.
  function* readLine() {
    let line = "";
    for (;;) {
      const chunk = yield SYS.read(0, 256);
      if (chunk === null) return line.length ? line : null; // EOF
      if (typeof chunk === "number") return null; // erreur de lecture
      const i = chunk.indexOf("\n");
      if (i >= 0) {
        line += chunk.slice(0, i);
        return line;
      }
      line += chunk;
    }
  }

  // Lit l'intégralité d'un fd déjà ouvert.
  function* slurp(fd) {
    let data = "";
    for (;;) {
      const chunk = yield SYS.read(fd, 4096);
      if (chunk === null) break;
      if (typeof chunk === "number") return { err: chunk };
      data += chunk;
    }
    return { data };
  }

  // --- module fs (node-like). Renvoie { data } / { err:codeNum }. -----------
  const fs = {
    *readFile(p) {
      const fd = yield SYS.open(p, "r");
      if (typeof fd === "number" && fd < 0) return { err: fd };
      const r = yield* slurp(fd);
      yield SYS.close(fd);
      return r;
    },
    *writeFile(p, data) {
      const fd = yield SYS.open(p, "w");
      if (typeof fd === "number" && fd < 0) return { err: fd };
      yield SYS.write(fd, data);
      yield SYS.close(fd);
      return {};
    },
    *appendFile(p, data) {
      const fd = yield SYS.open(p, "a");
      if (typeof fd === "number" && fd < 0) return { err: fd };
      yield SYS.write(fd, data);
      yield SYS.close(fd);
      return {};
    },
    *readdir(p) {
      return yield SYS.readdir(p);
    },
    *mkdir(p) {
      return yield SYS.mkdir(p);
    },
    *unlink(p, recursive = false) {
      return yield SYS.unlink(p, recursive);
    },
    *stat(p) {
      return yield SYS.stat(p);
    },
    *exists(p) {
      return (yield SYS.stat(p)) !== null;
    },
  };

  // --- module process (node-like) ------------------------------------------
  const process = {
    argv: proc.argv,
    env: { ...proc.env },
    pid: proc.pid,
    *cwd() {
      return yield SYS.getcwd();
    },
    *chdir(p) {
      return yield SYS.chdir(p);
    },
    *getenv(name) {
      return yield SYS.getenv(name);
    },
    *setenv(name, value) {
      return yield SYS.setenv(name, value);
    },
    *exit(code = 0) {
      return yield SYS.exit(code);
    },
  };

  // --- module console (node-like) ------------------------------------------
  const console = {
    *log(...args) {
      yield SYS.write(1, args.map(fmt).join(" ") + "\n");
    },
    *error(...args) {
      yield SYS.write(2, args.map(fmt).join(" ") + "\n");
    },
  };

  return {
    argv: proc.argv,
    env: { ...proc.env },
    pid: proc.pid,
    sys: SYS,
    write,
    out,
    err,
    readLine,
    slurp,
    fs,
    path,
    process,
    console,
    strerror,
  };
}
