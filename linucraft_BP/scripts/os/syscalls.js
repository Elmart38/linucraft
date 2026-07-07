// ---------------------------------------------------------------------------
// Appels système : helpers produisant les objets-descripteurs `yield`és par les
// programmes. Le programme ne reçoit jamais de référence directe au noyau, au
// VFS ou au monde : il ne voit que des nombres (fd, pid, codes errno) et des
// chaînes. C'est la frontière d'isolation entre userland et noyau.
//
// Un programme fait par exemple :  const fd = yield SYS.open("/etc/motd", "r");
// Le scheduler récupère { sys:"open", ... }, l'exécute, puis reprend le
// générateur via gen.next(résultat).
// ---------------------------------------------------------------------------

export const SYS = {
  // --- fichiers / I/O ---
  open: (path, mode = "r") => ({ sys: "open", path, mode }),
  read: (fd, n = 4096) => ({ sys: "read", fd, n }),
  write: (fd, data) => ({ sys: "write", fd, data }),
  close: (fd) => ({ sys: "close", fd }),
  dup2: (oldfd, newfd) => ({ sys: "dup2", oldfd, newfd }),
  pipe: () => ({ sys: "pipe" }),
  stat: (path) => ({ sys: "stat", path }),
  readdir: (path) => ({ sys: "readdir", path }),
  mkdir: (path) => ({ sys: "mkdir", path }),
  unlink: (path, recursive = false) => ({ sys: "unlink", path, recursive }),

  // --- processus ---
  spawn: (path, argv, opts = {}) => ({ sys: "spawn", path, argv, opts }),
  wait: (pid = -1) => ({ sys: "wait", pid }),
  exit: (code = 0) => ({ sys: "exit", code }),
  getpid: () => ({ sys: "getpid" }),
  kill: (pid) => ({ sys: "kill", pid }),
  sleep: (ticks) => ({ sys: "sleep", ticks }),
  yield: () => ({ sys: "yield" }),

  // --- environnement ---
  getcwd: () => ({ sys: "getcwd" }),
  chdir: (path) => ({ sys: "chdir", path }),
  getenv: (name) => ({ sys: "getenv", name }),
  setenv: (name, value) => ({ sys: "setenv", name, value }),
  environ: () => ({ sys: "environ" }),

  // --- identité & permissions ---
  getuid: () => ({ sys: "getuid" }),
  getgid: () => ({ sys: "getgid" }),
  setuid: (uid, user) => ({ sys: "setuid", uid, user }),
  chmod: (path, mode) => ({ sys: "chmod", path, mode }),
  chown: (path, uid, gid) => ({ sys: "chown", path, uid, gid }),
  symlink: (target, path) => ({ sys: "symlink", target, path }),
  lstat: (path) => ({ sys: "lstat", path }),

  // --- divers ---
  ps: () => ({ sys: "ps" }), // liste des processus (pour /bin/ps et /proc)
  hasProgram: (name) => ({ sys: "hasProgram", name }), // un binaire /bin/<name> existe-t-il ?
  usage: () => ({ sys: "usage" }), // occupation du FS (pour df)
  access: (path, need = "r") => ({ sys: "access", path, need }), // teste un droit (r|w|x) sans ouvrir ni créer
  host: (kind, payload) => ({ sys: "host", kind, payload }), // requête bloquante à la couche plateforme (Minecraft)
};
