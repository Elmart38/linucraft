// ---------------------------------------------------------------------------
// /bin/sh — le shell, devenu un PROCESSUS comme un autre. Il ne dispose
// d'aucun privilège : il manipule fichiers et processus via les appels système.
//
// Gère : séquences `;`, pipelines `|`, redirections `< > >>`, guillemets,
// expansion `$VAR`, et les built-ins cd/exit/export/unset/history/pwd.
// ---------------------------------------------------------------------------

const BUILTINS = new Set(["cd", "exit", "export", "unset", "history", ":"]);

// --- Lexer : découpe une ligne en tokens {t:'word'|'op', v} ----------------
function tokenize(line) {
  const toks = [];
  let i = 0;
  const breakers = " \t|<>;\"'";
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1,
        s = "";
      while (j < line.length && line[j] !== q) s += line[j++];
      i = j + 1;
      toks.push({ t: "word", v: s, quoted: true });
      continue;
    }
    if (c === "|") {
      toks.push({ t: "op", v: "|" });
      i++;
      continue;
    }
    if (c === ";") {
      toks.push({ t: "op", v: ";" });
      i++;
      continue;
    }
    if (c === "<") {
      toks.push({ t: "op", v: "<" });
      i++;
      continue;
    }
    if (c === ">") {
      if (line[i + 1] === ">") {
        toks.push({ t: "op", v: ">>" });
        i += 2;
      } else {
        toks.push({ t: "op", v: ">" });
        i++;
      }
      continue;
    }
    let j = i,
      s = "";
    while (j < line.length && !breakers.includes(line[j])) s += line[j++];
    i = j;
    toks.push({ t: "word", v: s });
  }
  return toks;
}

// --- Parser : tokens -> liste de séquences -> pipelines -> commandes -------
// Renvoie [ pipeline, ... ] où pipeline = [ {argv, redirs:[{op,target}]} , ... ]
function parse(toks) {
  const sequences = [];
  let pipeline = [];
  let cmd = { argvTokens: [], redirs: [] };
  let expectRedir = null;

  const endCmd = () => {
    if (cmd.argvTokens.length || cmd.redirs.length) pipeline.push(cmd);
    cmd = { argvTokens: [], redirs: [] };
  };
  const endPipeline = () => {
    endCmd();
    if (pipeline.length) sequences.push(pipeline);
    pipeline = [];
  };

  for (const tk of toks) {
    if (expectRedir) {
      cmd.redirs.push({ op: expectRedir, target: tk.v, quoted: !!tk.quoted });
      expectRedir = null;
      continue;
    }
    if (tk.t === "op") {
      if (tk.v === "|") endCmd();
      else if (tk.v === ";") endPipeline();
      else expectRedir = tk.v; // < > >>
    } else {
      cmd.argvTokens.push({ v: tk.v, quoted: !!tk.quoted });
    }
  }
  endPipeline();
  return sequences;
}

// Expansion des variables $VAR / ${VAR} dans un mot (sauf entre ' ').
function* expand(ctx, tk) {
  if (tk.quoted) return tk.v; // guillemets simples capturés : pas d'expansion
  let out = "";
  const s = tk.v;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "$") {
      let j = i + 1;
      let braced = false;
      if (s[j] === "{") {
        braced = true;
        j++;
      }
      let name = "";
      while (j < s.length && /[A-Za-z0-9_?]/.test(s[j])) name += s[j++];
      if (braced && s[j] === "}") j++;
      const val = name === "?" ? (yield ctx.sys.getenv("?")) : (yield ctx.sys.getenv(name));
      out += val == null ? "" : val;
      i = j - 1;
    } else out += s[i];
  }
  return out;
}

function* prompt(ctx) {
  const cwd = yield ctx.sys.getcwd();
  const user = (yield ctx.sys.getenv("USER")) || "user";
  const home = (yield ctx.sys.getenv("HOME")) || "/home";
  let disp = cwd;
  if (cwd === home) disp = "~";
  else if (cwd.startsWith(home + "/")) disp = "~" + cwd.slice(home.length);
  return `§a${user}@linucraft§r:§9${disp}§r$ `;
}

// --- Built-ins -------------------------------------------------------------
function* runBuiltin(ctx, argv, st, history) {
  const name = argv[0];
  switch (name) {
    case ":":
      return 0;
    case "exit":
      st.exit = true;
      return argv[1] ? parseInt(argv[1], 10) || 0 : 0;
    case "cd": {
      const target = argv[1] || (yield ctx.sys.getenv("HOME")) || "/";
      const r = yield ctx.sys.chdir(target);
      if (r < 0) {
        yield ctx.sys.write(2, `cd: ${target}: ${ctx.strerror(r)}\n`);
        return 1;
      }
      return 0;
    }
    case "export": {
      for (const a of argv.slice(1)) {
        const eq = a.indexOf("=");
        if (eq >= 0) yield ctx.sys.setenv(a.slice(0, eq), a.slice(eq + 1));
      }
      return 0;
    }
    case "unset": {
      for (const a of argv.slice(1)) yield ctx.sys.setenv(a, undefined);
      return 0;
    }
    case "history": {
      for (let i = 0; i < history.length; i++)
        yield ctx.sys.write(1, `${String(i + 1).padStart(4)}  ${history[i]}\n`);
      return 0;
    }
  }
  return 0;
}

// --- Exécution d'un pipeline ------------------------------------------------
function* execPipeline(ctx, cmds, st, history) {
  // Expansion des arguments.
  for (const cmd of cmds) {
    const expanded = [];
    for (const w of cmd.argvTokens) {
      const v = yield* expand(ctx, w);
      expanded.push(v);
    }
    cmd.argv = expanded.filter((v, idx) => v !== "" || cmd.argvTokens[idx].quoted);
  }

  // Cas built-in : uniquement si commande seule (modifie l'état du shell).
  if (cmds.length === 1 && BUILTINS.has(cmds[0].argv[0])) {
    return yield* runBuiltin(ctx, cmds[0].argv, st, history);
  }

  const n = cmds.length;
  const toClose = [];
  const pids = [];
  let inFd = 0;
  let ok = true;

  for (let i = 0; i < n && ok; i++) {
    const cmd = cmds[i];
    let curIn = inFd;
    let curOut = 1;
    let nextIn = 0;

    if (i < n - 1) {
      const pr = yield ctx.sys.pipe(); // [rfd, wfd]
      curOut = pr[1];
      nextIn = pr[0];
      toClose.push(pr[0], pr[1]);
    }

    // Redirections (priment sur les tubes).
    for (const rd of cmd.redirs) {
      const target = yield* expand(ctx, { v: rd.target, quoted: rd.quoted });
      if (rd.op === "<") {
        const fd = yield ctx.sys.open(target, "r");
        if (typeof fd === "number" && fd < 0) {
          yield ctx.sys.write(2, `lsh: ${target}: ${ctx.strerror(fd)}\n`);
          ok = false;
          break;
        }
        curIn = fd;
        toClose.push(fd);
      } else {
        const fd = yield ctx.sys.open(target, rd.op === ">>" ? "a" : "w");
        if (typeof fd === "number" && fd < 0) {
          yield ctx.sys.write(2, `lsh: ${target}: ${ctx.strerror(fd)}\n`);
          ok = false;
          break;
        }
        curOut = fd;
        toClose.push(fd);
      }
    }
    if (!ok) break;

    const prog = cmd.argv[0];
    if (!prog) {
      inFd = nextIn;
      continue;
    }
    const progPath = prog.includes("/") ? prog : "/bin/" + prog;
    const pid = yield ctx.sys.spawn(progPath, cmd.argv.slice(1), { fds: [curIn, curOut, 2] });
    pids.push(pid);
    inFd = nextIn;
  }

  // Le shell ferme ses copies des fd de tubes/redirections.
  for (const fd of toClose) yield ctx.sys.close(fd);

  // Attente de tous les processus du pipeline (code = celui du dernier).
  let code = 0;
  for (const pid of pids) {
    const c = yield ctx.sys.wait(pid);
    if (c >= 0) code = c;
  }
  return ok ? code : 1;
}

export function* sh(ctx) {
  // MOTD au démarrage.
  const motd = yield* ctx.fs.readFile("/etc/motd");
  if (!motd.err) yield ctx.sys.write(1, motd.data);

  const st = { exit: false };
  const history = [];

  for (;;) {
    yield ctx.sys.write(1, yield* prompt(ctx));
    const line = yield* ctx.readLine();
    if (line === null) break; // EOF -> fin du shell
    yield ctx.sys.write(1, line + "\n"); // écho terminal

    const trimmed = line.trim();
    if (trimmed === "") continue;
    history.push(trimmed);

    const sequences = parse(tokenize(trimmed));
    let code = 0;
    for (const pipeline of sequences) {
      code = yield* execPipeline(ctx, pipeline, st, history);
      if (st.exit) break;
    }
    yield ctx.sys.setenv("?", String(code));
    if (st.exit) return code;
  }
  return 0;
}
