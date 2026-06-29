// ---------------------------------------------------------------------------
// Programmes système de base (« coreutils »). Chacun est un générateur
// `function* main(ctx)` qui renvoie un code de sortie. Ils ne parlent au monde
// que via les appels système (ctx.sys) — aucune référence directe au noyau.
//
// Conventions :
//   yield ctx.sys.write(1, txt)   -> stdout
//   yield ctx.sys.write(2, txt)   -> stderr
//   const fd = yield ctx.sys.open(p, "r");  (fd < 0 => errno)
//   const chunk = yield ctx.sys.read(fd);   (null => EOF, number => errno)
// ---------------------------------------------------------------------------

const VERSION = "linucraft 2.0";

function parseFlags(args) {
  const flags = new Set();
  const ops = [];
  for (const a of args) {
    if (a.length > 1 && a.startsWith("-")) for (const ch of a.slice(1)) flags.add(ch);
    else ops.push(a);
  }
  return { flags, ops };
}

// Recopie tout un fd vers stdout.
function* pipeOut(ctx, fd) {
  for (;;) {
    const chunk = yield ctx.sys.read(fd, 4096);
    if (chunk === null) return 0;
    if (typeof chunk === "number") return 1;
    yield ctx.sys.write(1, chunk);
  }
}

export function* echo(ctx) {
  const args = ctx.argv.slice(1);
  let nonl = false;
  if (args[0] === "-n") {
    nonl = true;
    args.shift();
  }
  yield ctx.sys.write(1, args.join(" ") + (nonl ? "" : "\n"));
  return 0;
}

export function* cat(ctx) {
  const args = ctx.argv.slice(1);
  if (args.length === 0) return yield* pipeOut(ctx, 0);
  let code = 0;
  for (const a of args) {
    const fd = yield ctx.sys.open(a, "r");
    if (typeof fd === "number" && fd < 0) {
      yield ctx.sys.write(2, `cat: ${a}: ${ctx.strerror(fd)}\n`);
      code = 1;
      continue;
    }
    yield* pipeOut(ctx, fd);
    yield ctx.sys.close(fd);
  }
  return code;
}

export function* ls(ctx) {
  const { flags, ops } = parseFlags(ctx.argv.slice(1));
  const target = ops[0] ?? ".";
  const st = yield ctx.sys.stat(target);
  if (!st) {
    yield ctx.sys.write(2, `ls: cannot access '${target}': No such file or directory\n`);
    return 1;
  }
  if (st.type === "f") {
    yield ctx.sys.write(1, ctx.path.basename(target) + "\n");
    return 0;
  }
  let names = yield ctx.sys.readdir(target);
  if (typeof names === "number") {
    yield ctx.sys.write(2, `ls: ${target}: ${ctx.strerror(names)}\n`);
    return 1;
  }
  if (!flags.has("a")) names = names.filter((n) => !n.startsWith("."));
  const labeled = [];
  for (const n of names) {
    const s = yield ctx.sys.stat(target === "." ? n : ctx.path.join(target, n));
    labeled.push(s && s.type === "d" ? n + "/" : n);
  }
  if (labeled.length) yield ctx.sys.write(1, labeled.join(flags.has("l") ? "\n" : "  ") + "\n");
  return 0;
}

export function* pwd(ctx) {
  yield ctx.sys.write(1, (yield ctx.sys.getcwd()) + "\n");
  return 0;
}

export function* whoami(ctx) {
  yield ctx.sys.write(1, ((yield ctx.sys.getenv("USER")) || "user") + "\n");
  return 0;
}

export function* uname(ctx) {
  const { flags } = parseFlags(ctx.argv.slice(1));
  yield ctx.sys.write(
    1,
    (flags.has("a")
      ? "linucraft localhost 2.0 Minecraft Bedrock JS x86_64 linucraft"
      : "linucraft") + "\n"
  );
  return 0;
}

export function* date(ctx) {
  yield ctx.sys.write(1, new Date().toString() + "\n");
  return 0;
}

export function* env(ctx) {
  const e = yield ctx.sys.environ();
  for (const k of Object.keys(e).sort()) yield ctx.sys.write(1, `${k}=${e[k]}\n`);
  return 0;
}

export function* mkdir(ctx) {
  const args = ctx.argv.slice(1);
  if (!args.length) {
    yield ctx.sys.write(2, "mkdir: usage: mkdir <dossier>\n");
    return 1;
  }
  let code = 0;
  for (const a of args) {
    const r = yield ctx.sys.mkdir(a);
    if (r < 0) {
      yield ctx.sys.write(2, `mkdir: cannot create directory '${a}': ${ctx.strerror(r)}\n`);
      code = 1;
    }
  }
  return code;
}

export function* touch(ctx) {
  const args = ctx.argv.slice(1);
  if (!args.length) {
    yield ctx.sys.write(2, "touch: usage: touch <fichier>\n");
    return 1;
  }
  let code = 0;
  for (const a of args) {
    const fd = yield ctx.sys.open(a, "a");
    if (typeof fd === "number" && fd < 0) {
      yield ctx.sys.write(2, `touch: ${a}: ${ctx.strerror(fd)}\n`);
      code = 1;
    } else yield ctx.sys.close(fd);
  }
  return code;
}

export function* rm(ctx) {
  const { flags, ops } = parseFlags(ctx.argv.slice(1));
  if (!ops.length) {
    yield ctx.sys.write(2, "rm: usage: rm [-r] <chemin>\n");
    return 1;
  }
  const recursive = flags.has("r") || flags.has("f");
  let code = 0;
  for (const a of ops) {
    const r = yield ctx.sys.unlink(a, recursive);
    if (r < 0) {
      yield ctx.sys.write(2, `rm: cannot remove '${a}': ${ctx.strerror(r)}\n`);
      code = 1;
    }
  }
  return code;
}

export function* cp(ctx) {
  const args = ctx.argv.slice(1);
  if (args.length < 2) {
    yield ctx.sys.write(2, "cp: usage: cp <src> <dst>\n");
    return 1;
  }
  const [src, dst] = args;
  const r = yield* ctx.fs.readFile(src);
  if (r.err) {
    yield ctx.sys.write(2, `cp: ${src}: ${ctx.strerror(r.err)}\n`);
    return 1;
  }
  const w = yield* ctx.fs.writeFile(dst, r.data);
  if (w.err) {
    yield ctx.sys.write(2, `cp: ${dst}: ${ctx.strerror(w.err)}\n`);
    return 1;
  }
  return 0;
}

export function* mv(ctx) {
  const code = yield* cp(ctx);
  if (code !== 0) return code;
  yield ctx.sys.unlink(ctx.argv[1]);
  return 0;
}

// Lit toutes les lignes de stdin OU des fichiers passés en argument.
function* readLines(ctx, files) {
  const out = [];
  if (!files.length) {
    const r = yield* ctx.slurp(0);
    if (!r.err) for (const l of r.data.split("\n")) out.push(l);
    if (out.length && out[out.length - 1] === "") out.pop();
    return { lines: out };
  }
  for (const f of files) {
    const r = yield* ctx.fs.readFile(f);
    if (r.err) return { err: r.err, file: f };
    let ls = r.data.split("\n");
    if (ls.length && ls[ls.length - 1] === "") ls.pop();
    for (const l of ls) out.push(l);
  }
  return { lines: out };
}

export function* grep(ctx) {
  const { flags, ops } = parseFlags(ctx.argv.slice(1));
  if (!ops.length) {
    yield ctx.sys.write(2, "grep: usage: grep <motif> [fichier...]\n");
    return 1;
  }
  const pattern = ops[0];
  const invert = flags.has("v");
  const ic = flags.has("i");
  const needle = ic ? pattern.toLowerCase() : pattern;
  const r = yield* readLines(ctx, ops.slice(1));
  if (r.err) {
    yield ctx.sys.write(2, `grep: ${r.file}: ${ctx.strerror(r.err)}\n`);
    return 2;
  }
  let found = false;
  for (const line of r.lines) {
    const hay = ic ? line.toLowerCase() : line;
    const match = hay.includes(needle);
    if (match !== invert) {
      yield ctx.sys.write(1, line + "\n");
      found = true;
    }
  }
  return found ? 0 : 1;
}

export function* wc(ctx) {
  const { flags, ops } = parseFlags(ctx.argv.slice(1));
  const r = yield* readLines(ctx, ops);
  if (r.err) {
    yield ctx.sys.write(2, `wc: ${r.file}: ${ctx.strerror(r.err)}\n`);
    return 1;
  }
  const lines = r.lines.length;
  const words = r.lines.reduce((a, l) => a + (l.trim() ? l.trim().split(/\s+/).length : 0), 0);
  const chars = r.lines.reduce((a, l) => a + l.length + 1, 0);
  let out;
  if (flags.has("l")) out = String(lines);
  else if (flags.has("w")) out = String(words);
  else if (flags.has("c")) out = String(chars);
  else out = `${lines} ${words} ${chars}`;
  yield ctx.sys.write(1, out + "\n");
  return 0;
}

// Lit l'option de nombre de lignes (-n N ou -N) + la liste de fichiers.
function parseLineCount(args) {
  let n = 10;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-n") n = parseInt(args[++i], 10) || n;
    else if (/^-\d+$/.test(a)) n = parseInt(a.slice(1), 10);
    else files.push(a);
  }
  return { n, files };
}

export function* head(ctx) {
  const { n, files } = parseLineCount(ctx.argv.slice(1));
  const r = yield* readLines(ctx, files);
  if (r.err) {
    yield ctx.sys.write(2, `head: ${r.file}: ${ctx.strerror(r.err)}\n`);
    return 1;
  }
  for (const l of r.lines.slice(0, n)) yield ctx.sys.write(1, l + "\n");
  return 0;
}

export function* tail(ctx) {
  const { n, files } = parseLineCount(ctx.argv.slice(1));
  const r = yield* readLines(ctx, files);
  if (r.err) {
    yield ctx.sys.write(2, `tail: ${r.file}: ${ctx.strerror(r.err)}\n`);
    return 1;
  }
  for (const l of r.lines.slice(-n)) yield ctx.sys.write(1, l + "\n");
  return 0;
}

export function* sort(ctx) {
  const { flags, ops } = parseFlags(ctx.argv.slice(1));
  const r = yield* readLines(ctx, ops);
  if (r.err) {
    yield ctx.sys.write(2, `sort: ${r.file}: ${ctx.strerror(r.err)}\n`);
    return 1;
  }
  const lines = r.lines.slice().sort();
  if (flags.has("r")) lines.reverse();
  for (const l of lines) yield ctx.sys.write(1, l + "\n");
  return 0;
}

export function* clear(ctx) {
  yield ctx.sys.write(1, "\f"); // le TTY interprète form-feed comme « effacer ».
  return 0;
}

export function* sleep(ctx) {
  const secs = parseFloat(ctx.argv[1] || "0") || 0;
  yield ctx.sys.sleep(Math.round(secs * 20)); // 20 ticks par seconde
  return 0;
}

export function* ps(ctx) {
  const list = yield ctx.sys.ps();
  yield ctx.sys.write(1, "  PID  PPID STATE    CMD\n");
  for (const p of list)
    yield ctx.sys.write(
      1,
      `${String(p.pid).padStart(5)} ${String(p.ppid).padStart(5)} ${p.state.padEnd(8)} ${p.cmd}\n`
    );
  return 0;
}

export function* help(ctx) {
  const names = yield ctx.sys.readdir("/bin");
  const list = Array.isArray(names) ? names.slice().sort() : [];
  yield ctx.sys.write(
    1,
    "Commandes disponibles :\n  " +
      list.join("  ") +
      "\n\nExemples : ls -a   cd /etc   cat motd   echo salut > note.txt\n" +
      "          ls /bin | grep c | wc -l   ps   neofetch\n" +
      "Tape §aexit§r pour quitter le terminal.\n"
  );
  return 0;
}

export function* neofetch(ctx) {
  const user = (yield ctx.sys.getenv("USER")) || "user";
  const info = [
    `${user}@linucraft`,
    "-----------------",
    `OS: ${VERSION} (Bedrock)`,
    "Kernel: minecraft-js (coopératif)",
    "Shell: lsh 2.0",
    "Terminal: ModalForm/TTY",
    "CPU: Redstone Core",
  ];
  const logo = [
    "   .--.   ",
    "  |o_o |  ",
    "  |:_/ |  ",
    " //   \\ \\ ",
    "(|     | )",
    "/'\\_   _/`\\",
    "\\___)=(___/",
  ];
  const n = Math.max(logo.length, info.length);
  for (let i = 0; i < n; i++)
    yield ctx.sys.write(1, (logo[i] ?? "").padEnd(12) + (info[i] ?? "") + "\n");
  return 0;
}

export function* trueCmd() {
  return 0;
}
export function* falseCmd() {
  return 1;
}
