// ---------------------------------------------------------------------------
// /bin/sh — le shell de linucraft (lsh), un vrai petit interpréteur.
//
//   lexer  : source -> tokens (mots à parts + quotes, opérateurs, mots-clés)
//   parser : tokens -> AST (listes, and-or, pipelines, if/for/while)
//   éval   : générateur qui parcourt l'AST et yield des appels système
//
// Fonctionnalités : pipes | , redirections < > >> , séquences ; , arrière-plan &,
//   opérateurs && || , guillemets ' " , variables $VAR ${VAR} $? $$ $1..,
//   substitution de commande $(...), globs * ? [...], ~ , contrôle de flux
//   if/elif/else/fi , for..in..do..done , while/until..do..done , test/[ ,
//   built-ins cd/exit/export/unset/history/jobs/wait/source , exécution de
//   scripts (sh fichier, source fichier, ./script via shebang).
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi",
  "for", "in", "do", "done",
  "while", "until",
]);
const BUILTINS = new Set([
  "cd", "exit", "export", "unset", "history", ":", "test", "[",
  "jobs", "wait", "source", ".", "read", "eval", "sudo", "su",
]);

// ===========================================================================
// 1) LEXER
// ===========================================================================
function tokenize(src) {
  const toks = [];
  let i = 0;
  const isBlank = (c) => c === " " || c === "\t";
  const OPSTART = "|&;<>\n";

  while (i < src.length) {
    const c = src[i];
    if (isBlank(c)) { i++; continue; }
    if (c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "\n" || c === ";") { pushOp(";"); i++; continue; }
    if (c === "&") { if (src[i + 1] === "&") { pushOp("&&"); i += 2; } else { pushOp("&"); i++; } continue; }
    if (c === "|") { if (src[i + 1] === "|") { pushOp("||"); i += 2; } else { pushOp("|"); i++; } continue; }
    if (c === "<") { pushOp("<"); i++; continue; }
    if (c === ">") { if (src[i + 1] === ">") { pushOp(">>"); i += 2; } else { pushOp(">"); i++; } continue; }

    // --- mot (suite de parts) ---
    const parts = [];
    let hadQuote = false;
    while (i < src.length && !isBlank(src[i]) && !OPSTART.includes(src[i]) && src[i] !== "#") {
      const ch = src[i];
      if (ch === "'") {
        let j = i + 1, s = "";
        while (j < src.length && src[j] !== "'") s += src[j++];
        parts.push({ q: "single", t: s });
        hadQuote = true;
        i = j + 1;
      } else if (ch === '"') {
        // Guillemets doubles : texte + éventuelles substitutions $(...).
        let j = i + 1, s = "";
        const startLen = parts.length;
        hadQuote = true;
        while (j < src.length && src[j] !== '"') {
          if (src[j] === "\\" && (src[j + 1] === '"' || src[j + 1] === "\\" || src[j + 1] === "$")) { s += src[j + 1]; j += 2; }
          else if (src[j] === "$" && src[j + 1] === "(") {
            if (s) { parts.push({ q: "double", t: s }); s = ""; }
            const { inner, end } = readBalanced(src, j + 1);
            parts.push({ q: "cmdsub", t: inner, quoted: true });
            j = end;
          } else s += src[j++];
        }
        if (s) parts.push({ q: "double", t: s });
        if (parts.length === startLen) parts.push({ q: "double", t: "" }); // "" vide
        i = j + 1;
      } else if (ch === "$" && src[i + 1] === "(") {
        const { inner, end } = readBalanced(src, i + 1);
        parts.push({ q: "cmdsub", t: inner, quoted: false });
        i = end;
      } else if (ch === "\\") {
        parts.push({ q: "single", t: src[i + 1] ?? "" });
        i += 2;
      } else {
        let s = "";
        while (i < src.length && !isBlank(src[i]) && !OPSTART.includes(src[i]) &&
               src[i] !== "'" && src[i] !== '"' && src[i] !== "\\" && src[i] !== "#" &&
               !(src[i] === "$" && src[i + 1] === "(")) {
          s += src[i++];
        }
        parts.push({ q: "none", t: s });
      }
    }
    toks.push({ t: "word", parts, hadQuote });
  }
  toks.push({ t: "eof" });
  return toks;

  function pushOp(v) { toks.push({ t: "op", v }); }
}

// Lit une expression entre parenthèses équilibrées à partir de src[open]='(' .
function readBalanced(src, open) {
  let depth = 0, j = open, inner = "";
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "(") { depth++; if (depth === 1) continue; }
    else if (c === ")") { depth--; if (depth === 0) { j++; break; } }
    inner += c;
  }
  return { inner, end: j };
}

// Mot simple non quoté (pour reconnaître les mots-clés). Sinon null.
function plainWord(tok) {
  if (!tok || tok.t !== "word" || tok.hadQuote) return null;
  if (tok.parts.length === 1 && tok.parts[0].q === "none") return tok.parts[0].t;
  return null;
}

// ===========================================================================
// 2) PARSER (descente récursive)
// ===========================================================================
function parseAll(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const kw = () => { const w = plainWord(toks[p]); return w && KEYWORDS.has(w) ? w : null; };
  const eat = () => toks[p++];
  const skipSep = () => { while (peek().t === "op" && peek().v === ";") p++; };
  const err = (m) => { throw new Error(`syntax error: ${m}`); };

  function parseList(stops = []) {
    const items = [];
    skipSep();
    while (peek().t !== "eof" && !stops.includes(kw())) {
      const andor = parseAndOr();
      if (!andor) break;
      let background = false;
      if (peek().t === "op" && peek().v === "&") { background = true; eat(); }
      items.push({ andor, background });
      // séparateurs
      while (peek().t === "op" && (peek().v === ";" || peek().v === "&")) eat();
      if (stops.includes(kw())) break;
    }
    return { kind: "list", items };
  }

  function parseAndOr() {
    const list = [{ op: null, pipeline: parsePipeline() }];
    while (peek().t === "op" && (peek().v === "&&" || peek().v === "||")) {
      const op = eat().v;
      list.push({ op, pipeline: parsePipeline() });
    }
    return { kind: "andor", list };
  }

  function parsePipeline() {
    const cmds = [parseCommand()];
    while (peek().t === "op" && peek().v === "|") { eat(); cmds.push(parseCommand()); }
    return { kind: "pipeline", cmds };
  }

  function parseCommand() {
    const k = kw();
    if (k === "if") return parseIf();
    if (k === "for") return parseFor();
    if (k === "while" || k === "until") return parseWhile(k === "until");
    return parseSimple();
  }

  function parseSimple() {
    const words = [];
    const redirs = [];
    const assigns = [];
    for (;;) {
      const tk = peek();
      if (tk.t === "op" && (tk.v === "<" || tk.v === ">" || tk.v === ">>")) {
        const op = eat().v;
        if (peek().t !== "word") err("redirection sans cible");
        redirs.push({ op, target: eat().parts });
        continue;
      }
      if (tk.t !== "word") break;
      // affectation NAME=val en tête ?
      const w = plainWord(tk);
      const m = tk.parts[0] && tk.parts[0].q === "none" ? tk.parts[0].t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s) : null;
      if (words.length === 0 && m) {
        // reconstruit le mot valeur (le reste de la 1re part + parts suivantes)
        const valParts = [{ q: "none", t: m[2] }, ...tk.parts.slice(1)];
        assigns.push({ name: m[1], value: valParts });
        eat();
        continue;
      }
      words.push(eat().parts);
    }
    return { kind: "simple", words, redirs, assigns };
  }

  function parseIf() {
    eat(); // if
    const clauses = [];
    let cond = parseList(["then"]);
    if (kw() !== "then") err("'then' attendu"); eat();
    let body = parseList(["elif", "else", "fi"]);
    clauses.push({ cond, body });
    while (kw() === "elif") {
      eat();
      const c = parseList(["then"]);
      if (kw() !== "then") err("'then' attendu"); eat();
      const b = parseList(["elif", "else", "fi"]);
      clauses.push({ cond: c, body: b });
    }
    let elseBody = null;
    if (kw() === "else") { eat(); elseBody = parseList(["fi"]); }
    if (kw() !== "fi") err("'fi' attendu"); eat();
    return { kind: "if", clauses, elseBody };
  }

  function parseFor() {
    eat(); // for
    const varName = plainWord(peek());
    if (!varName) err("nom de variable attendu après for"); eat();
    let words = [];
    if (kw() === "in") {
      eat();
      while (peek().t === "word") words.push(eat().parts);
    }
    while (peek().t === "op" && peek().v === ";") eat();
    if (kw() !== "do") err("'do' attendu"); eat();
    const body = parseList(["done"]);
    if (kw() !== "done") err("'done' attendu"); eat();
    return { kind: "for", varName, words, body };
  }

  function parseWhile(until) {
    eat(); // while/until
    const cond = parseList(["do"]);
    if (kw() !== "do") err("'do' attendu"); eat();
    const body = parseList(["done"]);
    if (kw() !== "done") err("'done' attendu"); eat();
    return { kind: "while", cond, body, until };
  }

  const list = parseList();
  if (peek().t !== "eof") err(`inattendu: '${peek().v ?? "?"}'`);
  return list;
}

// ===========================================================================
// 3) EXPANSIONS
// ===========================================================================
function* getVar(ctx, name, state) {
  if (name === "?") return String(state.lastCode ?? 0);
  if (name === "$") return String(ctx.pid);
  if (/^[0-9]+$/.test(name)) return String(state.params[Number(name)] ?? "");
  if (name === "#") return String(Math.max(0, state.params.length - 1));
  if (name === "@" || name === "*") return state.params.slice(1).join(" ");
  const v = yield ctx.sys.getenv(name);
  return v == null ? "" : String(v);
}

function* expandVars(ctx, s, state) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "$") { out += s[i]; continue; }
    let j = i + 1;
    if (s[j] === "{") {
      j++;
      let name = "";
      while (j < s.length && s[j] !== "}") name += s[j++];
      j++;
      out += yield* getVar(ctx, name, state);
      i = j - 1;
    } else if (s[j] === "?" || s[j] === "$" || s[j] === "#" || s[j] === "@" || s[j] === "*") {
      out += yield* getVar(ctx, s[j], state);
      i = j;
    } else if (/[A-Za-z0-9_]/.test(s[j] || "")) {
      let name = "";
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) name += s[j++];
      out += yield* getVar(ctx, name, state);
      i = j - 1;
    } else out += "$";
  }
  return out;
}

// Transforme un motif glob en RegExp (sur un seul segment de chemin).
function globToRegex(seg) {
  let re = "^";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      let j = i + 1, cls = "[";
      if (seg[j] === "!" || seg[j] === "^") { cls += "^"; j++; }
      while (j < seg.length && seg[j] !== "]") cls += seg[j++];
      cls += "]";
      re += cls;
      i = j;
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return re + "$";
}

function* globWalk(ctx, dirPath, prefix, segs) {
  const [seg, ...rest] = segs;
  if (seg === undefined) return [prefix];
  if (!/[*?[]/.test(seg)) {
    const np = prefix === "" ? seg : prefix.endsWith("/") ? prefix + seg : prefix + "/" + seg;
    const nd = dirPath === "/" ? "/" + seg : dirPath + "/" + seg;
    if (rest.length === 0) return [np];
    return yield* globWalk(ctx, nd, np, rest);
  }
  const entries = yield ctx.sys.readdir(dirPath);
  if (!Array.isArray(entries)) return [];
  const re = new RegExp(globToRegex(seg));
  const showHidden = seg.startsWith(".");
  const out = [];
  for (const e of entries.slice().sort()) {
    if (!showHidden && e.startsWith(".")) continue;
    if (!re.test(e)) continue;
    const np = prefix === "" ? e : prefix.endsWith("/") ? prefix + e : prefix + "/" + e;
    const nd = dirPath === "/" ? "/" + e : dirPath + "/" + e;
    if (rest.length === 0) out.push(np);
    else {
      const st = yield ctx.sys.stat(nd);
      if (st && st.type === "d") out.push(...(yield* globWalk(ctx, nd, np, rest)));
    }
  }
  return out;
}

function* globField(ctx, pattern) {
  if (!/[*?[]/.test(pattern)) return null;
  const abs = pattern.startsWith("/");
  const segs = pattern.split("/").filter((s) => s !== "");
  const matches = yield* globWalk(ctx, abs ? "/" : ".", abs ? "/" : "", segs);
  return matches.length ? matches.sort() : null;
}

// Développe un mot (liste de parts) en une liste de champs (arguments).
function* expandWord(ctx, parts, state, { assignCtx = false } = {}) {
  const fields = [""];
  const globable = [false];
  const home = (yield ctx.sys.getenv("HOME")) || "/home";

  const appendLit = (s) => { fields[fields.length - 1] += s; };
  const appendGlobbable = (s) => {
    fields[fields.length - 1] += s;
    if (/[*?[]/.test(s)) globable[fields.length - 1] = true;
  };
  const appendSplit = (s) => {
    if (assignCtx) { appendGlobbable(s); return; } // pas de découpage en affectation
    const pieces = s.split(/[ \t\n]+/);
    for (let k = 0; k < pieces.length; k++) {
      if (k > 0) { fields.push(""); globable.push(false); }
      if (pieces[k] !== "") appendGlobbable(pieces[k]);
    }
  };

  for (let pi = 0; pi < parts.length; pi++) {
    const p = parts[pi];
    if (p.q === "single") appendLit(p.t);
    else if (p.q === "double") appendLit(yield* expandVars(ctx, p.t, state));
    else if (p.q === "cmdsub") {
      const outp = yield* captureRun(ctx, p.t, state);
      if (p.quoted) appendLit(outp); else appendSplit(outp);
    } else {
      // none : ~ en tête + variables (résultats découpables)
      let t = p.t;
      if (pi === 0 && (t === "~" || t.startsWith("~/"))) t = home + t.slice(1);
      appendSplit(yield* expandVars(ctx, t, state));
    }
  }

  // Globbing des champs marqués.
  const out = [];
  for (let k = 0; k < fields.length; k++) {
    if (globable[k]) {
      const g = yield* globField(ctx, fields[k]);
      if (g) { out.push(...g); continue; }
    }
    out.push(fields[k]);
  }
  // Suppression des champs vides issus d'expansions non quotées.
  const hadQuote = parts.some((p) => p.q === "single" || p.q === "double" || (p.q === "cmdsub" && p.quoted));
  return out.filter((f) => f !== "" || hadQuote || assignCtx);
}

// Exécute une sous-commande $(...) en capturant sa sortie standard.
function* captureRun(ctx, srcInner, state) {
  const save = 20 + (state.depth || 0);
  const pr = yield ctx.sys.pipe(); // [r, w]
  yield ctx.sys.dup2(1, save); // sauvegarde stdout
  yield ctx.sys.dup2(pr[1], 1); // stdout -> tube
  yield ctx.sys.close(pr[1]);
  const subState = { ...state, depth: (state.depth || 0) + 1, lastCode: state.lastCode };
  try {
    const ast = parseAll(srcInner);
    yield* evalList(ctx, ast, subState);
  } catch (e) {
    yield ctx.sys.write(2, `lsh: ${e.message || e}\n`);
  }
  yield ctx.sys.dup2(save, 1); // restaure stdout (ferme le tube -> EOF)
  yield ctx.sys.close(save);
  let out = "";
  for (;;) {
    const c = yield ctx.sys.read(pr[0], 4096);
    if (c === null || typeof c === "number") break;
    out += c;
  }
  yield ctx.sys.close(pr[0]);
  state.lastCode = subState.lastCode;
  return out.replace(/\n+$/, "");
}

// ===========================================================================
// 4) ÉVALUATION
// ===========================================================================
function* evalList(ctx, list, state) {
  let code = state.lastCode ?? 0;
  for (const item of list.items) {
    if (state.exit) break;
    if (item.background) {
      code = yield* evalAndOr(ctx, item.andor, state, true);
    } else {
      code = yield* evalAndOr(ctx, item.andor, state, false);
    }
    state.lastCode = code;
  }
  return code;
}

function* evalAndOr(ctx, andor, state, background) {
  let code = 0;
  let run = true;
  for (const { op, pipeline } of andor.list) {
    if (op === "&&") run = code === 0;
    else if (op === "||") run = code !== 0;
    if (!run) continue;
    code = yield* evalPipeline(ctx, pipeline, state, background);
    state.lastCode = code;
  }
  return code;
}

function* evalPipeline(ctx, pipeline, state, background) {
  const cmds = pipeline.cmds;

  // Cas 1 : commande unique.
  if (cmds.length === 1) {
    const cmd = cmds[0];
    if (cmd.kind !== "simple") return yield* evalCompound(ctx, cmd, state);
    return yield* evalSimple(ctx, cmd, state, background);
  }

  // Cas 2 : pipeline multi-étages (chaque étage = commande simple externe).
  const toClose = [];
  const pids = [];
  const labels = [];
  let inFd = 0;
  let ok = true;

  for (let idx = 0; idx < cmds.length && ok; idx++) {
    const cmd = cmds[idx];
    let curIn = inFd, curOut = 1, nextIn = 0;
    if (idx < cmds.length - 1) {
      const pr = yield ctx.sys.pipe();
      curOut = pr[1]; nextIn = pr[0];
      toClose.push(pr[0], pr[1]);
    }
    const built = cmd.kind === "simple" ? yield* buildSimple(ctx, cmd, state) : null;
    if (!built) { // compound au milieu d'un pipe : non supporté, on saute
      inFd = nextIn; continue;
    }
    for (const rd of built.redirs) {
      const fd = yield ctx.sys.open(rd.target, rd.op === "<" ? "r" : rd.op === ">>" ? "a" : "w");
      if (typeof fd === "number" && fd < 0) {
        yield ctx.sys.write(2, `lsh: ${rd.target}: ${ctx.strerror(fd)}\n`);
        ok = false; break;
      }
      if (rd.op === "<") curIn = fd; else curOut = fd;
      toClose.push(fd);
    }
    if (!ok) break;
    if (!built.argv.length) { inFd = nextIn; continue; }
    const pid = yield* spawnResolved(ctx, built.argv, [curIn, curOut, 2], state, background ? { bg: true } : {});
    if (pid > 0) {
      pids.push(pid);
      labels.push(built.argv.join(" "));
    }
    inFd = nextIn;
  }
  for (const fd of toClose) yield ctx.sys.close(fd);

  if (background) {
    // `a | b &` : le pipeline entier part en arrière-plan, on n'attend pas.
    const last = pids[pids.length - 1];
    if (last) {
      state.jobs.push({ pid: last, cmd: labels.join(" | ") });
      yield ctx.sys.write(1, `[${state.jobs.length}] ${last}\n`);
    }
    return 0;
  }

  let code = 0;
  for (const pid of pids) { const c = yield ctx.sys.wait(pid); if (c >= 0) code = c; }
  return ok ? code : 1;
}

// Prépare argv (expansé) + redirs (cibles expansées) d'une commande simple.
function* buildSimple(ctx, cmd, state) {
  const argv = [];
  for (const w of cmd.words) argv.push(...(yield* expandWord(ctx, w, state)));
  const redirs = [];
  for (const rd of cmd.redirs) {
    const t = yield* expandWord(ctx, rd.target, state);
    redirs.push({ op: rd.op, target: t[0] ?? "" });
  }
  return { argv, redirs, assigns: cmd.assigns };
}

function* evalSimple(ctx, cmd, state, background) {
  const built = yield* buildSimple(ctx, cmd, state);

  // Affectations de variables.
  if (cmd.assigns.length) {
    for (const a of cmd.assigns) {
      const v = (yield* expandWord(ctx, a.value, state, { assignCtx: true }))[0] ?? "";
      yield ctx.sys.setenv(a.name, v);
    }
    if (!built.argv.length) return 0; // affectation pure
  }

  // Built-ins (modifient l'état du shell : uniquement en avant-plan, non pipeline).
  if (built.argv.length && BUILTINS.has(built.argv[0]) && !background) {
    return yield* runBuiltin(ctx, built.argv, state);
  }

  if (!built.argv.length) return 0;

  // Redirections (avant-plan).
  const toClose = [];
  let inFd = 0, outFd = 1, ok = true;
  for (const rd of built.redirs) {
    const fd = yield ctx.sys.open(rd.target, rd.op === "<" ? "r" : rd.op === ">>" ? "a" : "w");
    if (typeof fd === "number" && fd < 0) {
      yield ctx.sys.write(2, `lsh: ${rd.target}: ${ctx.strerror(fd)}\n`);
      ok = false; break;
    }
    if (rd.op === "<") inFd = fd; else outFd = fd;
    toClose.push(fd);
  }
  if (!ok) { for (const fd of toClose) yield ctx.sys.close(fd); return 1; }

  const pid = yield* spawnResolved(ctx, built.argv, [inFd, outFd, 2], state, background ? { bg: true } : {});
  for (const fd of toClose) yield ctx.sys.close(fd);
  if (pid <= 0) return 127;

  if (background) {
    state.jobs.push({ pid, cmd: built.argv.join(" ") });
    yield ctx.sys.write(1, `[${state.jobs.length}] ${pid}\n`);
    return 0;
  }
  const code = yield ctx.sys.wait(pid);
  return code < 0 ? 0 : code;
}

// Résout un nom de commande en /bin/<nom>, gère les scripts (#!) et spawn.
// `extra` permet de forcer l'identité (sudo → uid 0) ou le fond (bg).
function* spawnResolved(ctx, argv, fds, state, extra = {}) {
  const name = argv[0];
  const progPath = name.includes("/") ? name : "/bin/" + name;
  const has = yield ctx.sys.hasProgram(name);
  if (!has) {
    // Script ? (fichier avec shebang) -> exécuté par son interpréteur.
    const st = yield ctx.sys.stat(progPath);
    if (st && st.type === "f") {
      // Exécution directe (./x, /chemin/x) : le bit x est requis, comme sous Unix.
      if (name.includes("/")) {
        const uid = yield ctx.sys.getuid();
        const gid = yield ctx.sys.getgid();
        const xok =
          uid === 0 ? (st.mode & 0o111) !== 0
          : uid === st.uid ? ((st.mode >> 6) & 1) !== 0
          : gid === st.gid ? ((st.mode >> 3) & 1) !== 0
          : (st.mode & 1) !== 0;
        if (!xok) {
          yield ctx.sys.write(2, `lsh: ${name}: Permission denied\n`);
          return -1;
        }
      }
      const fd = yield ctx.sys.open(progPath, "r");
      if (typeof fd !== "number" || fd >= 0) {
        const first = yield ctx.sys.read(fd, 80);
        yield ctx.sys.close(fd);
        if (typeof first === "string" && first.startsWith("#!")) {
          const interp = first.slice(2).split("\n")[0].trim().split(/\s+/)[0] || "/bin/sh";
          const okInterp = yield ctx.sys.hasProgram(interp);
          if (!okInterp) {
            yield ctx.sys.write(2, `lsh: ${name}: bad interpreter: ${interp}\n`);
            return -1;
          }
          return yield ctx.sys.spawn(interp, [progPath, ...argv.slice(1)], { fds, ...extra });
        }
      }
    }
  }
  return yield ctx.sys.spawn(progPath, argv.slice(1), { fds, ...extra });
}

function* evalCompound(ctx, node, state) {
  if (node.kind === "if") {
    for (const cl of node.clauses) {
      const c = yield* evalList(ctx, cl.cond, state);
      if (c === 0) return yield* evalList(ctx, cl.body, state);
    }
    if (node.elseBody) return yield* evalList(ctx, node.elseBody, state);
    return 0;
  }
  if (node.kind === "for") {
    const items = [];
    for (const w of node.words) items.push(...(yield* expandWord(ctx, w, state)));
    let code = 0;
    for (const it of items) {
      if (state.exit) break;
      yield ctx.sys.setenv(node.varName, it);
      code = yield* evalList(ctx, node.body, state);
    }
    return code;
  }
  if (node.kind === "while") {
    let code = 0, guard = 0;
    for (;;) {
      if (state.exit || guard++ > 100000) break;
      const c = yield* evalList(ctx, node.cond, state);
      const ok = node.until ? c !== 0 : c === 0;
      if (!ok) break;
      code = yield* evalList(ctx, node.body, state);
    }
    return code;
  }
  return 0;
}

// ===========================================================================
// 5) BUILT-INS
// ===========================================================================
function* runBuiltin(ctx, argv, state) {
  switch (argv[0]) {
    case ":": return 0;
    case "exit": state.exit = true; return argv[1] ? parseInt(argv[1], 10) || 0 : (state.lastCode ?? 0);
    case "cd": {
      const target = argv[1] || (yield ctx.sys.getenv("HOME")) || "/";
      const r = yield ctx.sys.chdir(target);
      if (r < 0) { yield ctx.sys.write(2, `cd: ${target}: ${ctx.strerror(r)}\n`); return 1; }
      return 0;
    }
    case "export": {
      for (const a of argv.slice(1)) { const eq = a.indexOf("="); if (eq >= 0) yield ctx.sys.setenv(a.slice(0, eq), a.slice(eq + 1)); }
      return 0;
    }
    case "unset": { for (const a of argv.slice(1)) yield ctx.sys.setenv(a, undefined); return 0; }
    case "history": { for (let i = 0; i < state.history.length; i++) yield ctx.sys.write(1, `${String(i + 1).padStart(4)}  ${state.history[i]}\n`); return 0; }
    case "test": case "[": return yield* builtinTest(ctx, argv);
    case "jobs": {
      for (let i = 0; i < state.jobs.length; i++) yield ctx.sys.write(1, `[${i + 1}] ${state.jobs[i].pid}  ${state.jobs[i].cmd}\n`);
      return 0;
    }
    case "wait": {
      const jobs = state.jobs.splice(0);
      for (const j of jobs) yield ctx.sys.wait(j.pid);
      return 0;
    }
    case "eval": { const src = argv.slice(1).join(" "); try { return yield* evalList(ctx, parseAll(src), state); } catch (e) { yield ctx.sys.write(2, `lsh: ${e.message || e}\n`); return 2; } }
    case "source": case ".": {
      if (!argv[1]) { yield ctx.sys.write(2, "source: fichier attendu\n"); return 1; }
      const r = yield* ctx.fs.readFile(argv[1]);
      if (r.err) { yield ctx.sys.write(2, `source: ${argv[1]}: ${ctx.strerror(r.err)}\n`); return 1; }
      const saved = state.params;
      state.params = [argv[1], ...argv.slice(2)];
      try { return yield* evalList(ctx, parseAll(r.data), state); }
      catch (e) { yield ctx.sys.write(2, `lsh: ${e.message || e}\n`); return 2; }
      finally { state.params = saved; }
    }
    case "read": {
      const line = yield* ctx.readLine();
      const names = argv.slice(1).length ? argv.slice(1) : ["REPLY"];
      const vals = (line ?? "").split(/\s+/);
      for (let i = 0; i < names.length; i++)
        yield ctx.sys.setenv(names[i], i === names.length - 1 ? vals.slice(i).join(" ") : (vals[i] ?? ""));
      return line === null ? 1 : 0;
    }
    case "su": {
      const who = argv[1] || "root";
      const uid = who === "root" ? 0 : 1000;
      yield ctx.sys.setuid(uid, who);
      const home = uid === 0 ? "/root" : "/home/" + who;
      const st = yield ctx.sys.stat(home);
      if (st && st.type === "d") { yield ctx.sys.setenv("HOME", home); yield ctx.sys.chdir(home); }
      return 0;
    }
    case "sudo": {
      if (!argv[1]) { yield ctx.sys.write(2, "usage: sudo <commande>\n"); return 1; }
      const pid = yield* spawnResolved(ctx, argv.slice(1), [0, 1, 2], state, { uid: 0, gid: 0, user: "root" });
      if (pid <= 0) return 127;
      const code = yield ctx.sys.wait(pid);
      return code < 0 ? 0 : code;
    }
  }
  return 0;
}

function* builtinTest(ctx, argv) {
  let a = argv.slice(1);
  if (argv[0] === "[") {
    if (a[a.length - 1] !== "]") { yield ctx.sys.write(2, "[: manque ']'\n"); return 2; }
    a = a.slice(0, -1);
  }
  let res;
  if (a.length === 0) res = false;
  else if (a.length === 1) res = a[0] !== "";
  else if (a.length === 2) {
    const [op, v] = a;
    if (op === "-z") res = v === "";
    else if (op === "-n") res = v !== "";
    else if (op === "!") res = !(v !== "");
    else if ("-e-f-d-r-w-x-s".includes(op)) {
      const st = yield ctx.sys.stat(v);
      if (!st) res = false;
      else if (op === "-d") res = st.type === "d";
      else if (op === "-f") res = st.type === "f";
      else if (op === "-s") res = (st.size || 0) > 0;
      else res = true; // -e -r -w -x
    } else res = false;
  } else {
    const [l, op, r] = a;
    const ni = parseInt(l, 10), nj = parseInt(r, 10);
    switch (op) {
      case "=": case "==": res = l === r; break;
      case "!=": res = l !== r; break;
      case "-eq": res = ni === nj; break;
      case "-ne": res = ni !== nj; break;
      case "-lt": res = ni < nj; break;
      case "-le": res = ni <= nj; break;
      case "-gt": res = ni > nj; break;
      case "-ge": res = ni >= nj; break;
      default: res = false;
    }
  }
  return res ? 0 : 1;
}

// ===========================================================================
// 6) POINT D'ENTRÉE
// ===========================================================================
function* prompt(ctx) {
  const cwd = yield ctx.sys.getcwd();
  const user = (yield ctx.sys.getenv("USER")) || "user";
  const home = (yield ctx.sys.getenv("HOME")) || "/home";
  const uid = yield ctx.sys.getenv("UID");
  let disp = cwd;
  if (cwd === home) disp = "~";
  else if (cwd.startsWith(home + "/")) disp = "~" + cwd.slice(home.length);
  const sigil = uid === "0" ? "#" : "$";
  return `§a${user}@linucraft§r:§9${disp}§r${sigil} `;
}

export function* sh(ctx) {
  const state = { lastCode: 0, params: ctx.argv.slice(), jobs: [], history: [], exit: false, depth: 0 };

  // Mode commande : `sh -c "..."`.
  const cIdx = ctx.argv.indexOf("-c");
  if (cIdx >= 0 && ctx.argv[cIdx + 1] != null) {
    state.params = ["sh", ...ctx.argv.slice(cIdx + 2)];
    try { return yield* evalList(ctx, parseAll(ctx.argv[cIdx + 1]), state); }
    catch (e) { yield ctx.sys.write(2, `sh: ${e.message || e}\n`); return 2; }
  }

  // Mode script : `sh fichier [args]` — exécute le fichier puis sort.
  const fileArg = ctx.argv.slice(1).find((a) => !a.startsWith("-"));
  if (fileArg) {
    const r = yield* ctx.fs.readFile(fileArg);
    if (r.err) { yield ctx.sys.write(2, `sh: ${fileArg}: ${ctx.strerror(r.err)}\n`); return 1; }
    state.params = [fileArg, ...ctx.argv.slice(ctx.argv.indexOf(fileArg) + 1)];
    try { return yield* evalList(ctx, parseAll(r.data), state); }
    catch (e) { yield ctx.sys.write(2, `sh: ${e.message || e}\n`); return 2; }
  }

  // Mode interactif.
  const motd = yield* ctx.fs.readFile("/etc/motd");
  if (!motd.err) yield ctx.sys.write(1, motd.data);

  for (;;) {
    yield ctx.sys.write(1, yield* prompt(ctx));
    const line = yield* ctx.readLine();
    if (line === null) break;
    yield ctx.sys.write(1, line + "\n"); // écho terminal
    if (line.trim() === "") continue;
    state.history.push(line.trim());
    try {
      yield* evalList(ctx, parseAll(line), state);
    } catch (e) {
      yield ctx.sys.write(2, `lsh: ${e.message || e}\n`);
      state.lastCode = 2;
    }
    yield ctx.sys.setenv("?", String(state.lastCode ?? 0));
    if (state.exit) return state.lastCode ?? 0;
  }
  return 0;
}
