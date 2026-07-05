// ---------------------------------------------------------------------------
// Programmes liés au système de fichiers v2 : permissions, propriété, liens,
// occupation disque, identité.  chmod chown stat ln df du id
// ---------------------------------------------------------------------------

// "-rwxr-xr-x" à partir d'un type et d'un mode.
export function modeStr(type, mode) {
  const t = type === "d" ? "d" : type === "l" ? "l" : "-";
  const rwx = (b) => ((b & 4) ? "r" : "-") + ((b & 2) ? "w" : "-") + ((b & 1) ? "x" : "-");
  return t + rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7);
}

// Applique une spec symbolique (ex. u+x, a-w, +r) à un mode existant.
function applySymbolic(mode, spec) {
  const m = spec.match(/^([ugoa]*)([+\-=])([rwx]+)$/);
  if (!m) return mode;
  const who = m[1] || "a";
  const op = m[2];
  let mask = 0;
  if (m[3].includes("r")) mask |= 4;
  if (m[3].includes("w")) mask |= 2;
  if (m[3].includes("x")) mask |= 1;
  let full = 0;
  if (who.includes("u") || who.includes("a")) full |= mask << 6;
  if (who.includes("g") || who.includes("a")) full |= mask << 3;
  if (who.includes("o") || who.includes("a")) full |= mask;
  if (op === "+") return mode | full;
  if (op === "-") return mode & ~full;
  return full; // '='
}

export function* chmod(ctx) {
  const args = ctx.argv.slice(1);
  if (args.length < 2) { yield ctx.sys.write(2, "chmod: usage: chmod <mode> <fichier>\n"); return 1; }
  const spec = args[0];
  let code = 0;
  for (const t of args.slice(1)) {
    const st = yield ctx.sys.lstat(t);
    if (!st) { yield ctx.sys.write(2, `chmod: ${t}: ${ctx.strerror(-2)}\n`); code = 1; continue; }
    const mode = /^[0-7]{3,4}$/.test(spec) ? parseInt(spec, 8) & 0o777 : applySymbolic(st.mode, spec);
    const r = yield ctx.sys.chmod(t, mode);
    if (r < 0) { yield ctx.sys.write(2, `chmod: ${t}: ${ctx.strerror(r)}\n`); code = 1; }
  }
  return code;
}

export function* chown(ctx) {
  const args = ctx.argv.slice(1);
  if (args.length < 2) { yield ctx.sys.write(2, "chown: usage: chown <uid[:gid]> <fichier>\n"); return 1; }
  const [ownerPart, ...targets] = args;
  const [uStr, gStr] = ownerPart.split(":");
  const uid = uStr === "root" ? 0 : /^\d+$/.test(uStr) ? parseInt(uStr, 10) : 1000;
  const gid = gStr == null ? uid : gStr === "root" ? 0 : /^\d+$/.test(gStr) ? parseInt(gStr, 10) : 1000;
  let code = 0;
  for (const t of targets) {
    const r = yield ctx.sys.chown(t, uid, gid);
    if (r < 0) { yield ctx.sys.write(2, `chown: ${t}: ${ctx.strerror(r)}\n`); code = 1; }
  }
  return code;
}

export function* stat(ctx) {
  const args = ctx.argv.slice(1);
  if (!args.length) { yield ctx.sys.write(2, "stat: usage: stat <fichier>\n"); return 1; }
  let code = 0;
  for (const a of args) {
    const st = yield ctx.sys.lstat(a);
    if (!st) { yield ctx.sys.write(2, `stat: ${a}: ${ctx.strerror(-2)}\n`); code = 1; continue; }
    const type = st.type === "d" ? "directory" : st.type === "l" ? "symbolic link" : "regular file";
    yield ctx.sys.write(1,
      `  File: ${a}${st.target ? " -> " + st.target : ""}\n` +
      `  Size: ${st.size}\tType: ${type}\n` +
      `Access: (0${(st.mode & 0o777).toString(8)}/${modeStr(st.type, st.mode)})  Uid: ${st.uid}  Gid: ${st.gid}\n`);
  }
  return code;
}

export function* ln(ctx) {
  const args = ctx.argv.slice(1);
  const symbolic = args[0] === "-s";
  const ops = symbolic ? args.slice(1) : args;
  if (!symbolic) { yield ctx.sys.write(2, "ln: seuls les liens symboliques (-s) sont supportés\n"); return 1; }
  if (ops.length < 1) { yield ctx.sys.write(2, "ln: usage: ln -s <cible> [nom]\n"); return 1; }
  const target = ops[0];
  const name = ops[1] || target.split("/").filter(Boolean).pop();
  const r = yield ctx.sys.symlink(target, name);
  if (r < 0) { yield ctx.sys.write(2, `ln: ${name}: ${ctx.strerror(r)}\n`); return 1; }
  return 0;
}

export function* df(ctx) {
  const u = yield ctx.sys.usage();
  yield ctx.sys.write(1, "Filesystem      Fichiers  Dossiers      Octets\n");
  yield ctx.sys.write(1, `linucraft-fs ${String(u.files).padStart(11)} ${String(u.dirs).padStart(9)} ${String(u.bytes).padStart(11)}\n`);
  return 0;
}

function* duBytes(ctx, path) {
  const st = yield ctx.sys.lstat(path);
  if (!st) return 0;
  if (st.type !== "d") return st.size;
  let total = 0;
  const names = yield ctx.sys.readdir(path);
  if (Array.isArray(names)) for (const n of names) total += yield* duBytes(ctx, path === "/" ? "/" + n : path + "/" + n);
  return total;
}

export function* du(ctx) {
  const path = ctx.argv[1] || ".";
  const total = yield* duBytes(ctx, path);
  yield ctx.sys.write(1, `${total}\t${path}\n`);
  return 0;
}

export function* id(ctx) {
  const uid = yield ctx.sys.getuid();
  const gid = yield ctx.sys.getgid();
  const user = (yield ctx.sys.getenv("USER")) || "user";
  yield ctx.sys.write(1, `uid=${uid}(${user}) gid=${gid}(${gid === 0 ? "root" : user})\n`);
  return 0;
}
