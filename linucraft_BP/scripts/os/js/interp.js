import { SYS } from "../syscalls.js";
import { strerror } from "../errno.js";
import { path } from "../stdlib.js";
import { parseProgram } from "./parser.js";

// ---------------------------------------------------------------------------
// Évaluateur du sous-ensemble JavaScript — le « moteur node » de linucraft.
//
// Tout l'évaluateur est un GÉNÉRATEUR : chaque appel hôte (console.log,
// fs.readFile, require…) fait un `yield SYS.*` qui remonte jusqu'au noyau, et
// un compteur de « fuel » fait un `yield SYS.yield()` régulier pendant le pur
// calcul. Résultat : un `while (true) {}` utilisateur ne gèle jamais le jeu —
// il est préempté par l'ordonnanceur comme n'importe quel processus.
//
// Les valeurs interprétées SONT des valeurs JS natives (nombres, chaînes,
// objets simples, tableaux). Les fonctions utilisateur sont des fermetures
// {__fn:true, node, scope} exécutées par l'évaluateur ; les méthodes natives
// (Math.max, "a".toUpperCase, arr.join…) sont appelées directement, ce qui
// offre toute la bibliothèque standard « gratuitement ».
// ---------------------------------------------------------------------------

const FUEL = 256; // opérations entre deux yields de préemption
const MAX_DEPTH = 200; // profondeur d'appels interprétés

// Trous de sandbox classiques : on bloque l'accès à ces propriétés.
const FORBIDDEN = new Set([
  "constructor", "__proto__", "__defineGetter__", "__defineSetter__",
  "__lookupGetter__", "__lookupSetter__",
]);

// --- Erreurs -----------------------------------------------------------------
class Thrown {
  constructor(value) {
    this.thrown = true;
    this.value = value;
  }
}
function ierr(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}
function catchable(name, message) {
  return new Thrown({ name, message });
}
// Valeur liée par `catch (e)`.
function toCatchable(e) {
  if (e instanceof Thrown) return e.value;
  if (e instanceof Error) return { name: e.name, message: e.message };
  return e;
}
export function errText(e) {
  if (e instanceof Thrown) {
    const v = e.value;
    if (v && typeof v === "object" && v.name) return `${v.name}: ${v.message ?? ""}`;
    return "Uncaught: " + inspect(v, true);
  }
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

// --- Portées -------------------------------------------------------------------
class Scope {
  constructor(parent) {
    this.vars = new Map();
    this.parent = parent;
    this.hasThis = false;
    this.thisVal = undefined;
  }
  declare(name, value, kind) {
    this.vars.set(name, { v: value, k: kind });
  }
  lookup(name) {
    for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
    return null;
  }
  has(name) {
    return !!this.lookup(name);
  }
  get(name) {
    const b = this.lookup(name);
    if (!b) throw ierr("ReferenceError", `${name} is not defined`);
    return b.v;
  }
  set(name, value) {
    const b = this.lookup(name);
    if (!b) throw ierr("ReferenceError", `${name} is not defined`);
    if (b.k === "const") throw ierr("TypeError", `Assignment to constant variable '${name}'`);
    b.v = value;
    return value;
  }
  getThis() {
    for (let s = this; s; s = s.parent) if (s.hasThis) return s.thisVal;
    return undefined;
  }
}

// --- Affichage (console + REPL) ------------------------------------------------
export function inspect(v, quote = false, d = 0) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  const t = typeof v;
  if (t === "string") return quote ? JSON.stringify(v) : v;
  if (t === "number" || t === "boolean") return String(v);
  if (v.__fn) return `[Function: ${v.name || "anonyme"}]`;
  if (t === "function") return "[Function native]";
  if (Array.isArray(v)) {
    if (d > 2) return "[…]";
    if (!v.length) return "[]";
    return "[ " + v.map((x) => inspect(x, true, d + 1)).join(", ") + " ]";
  }
  if (t === "object") {
    if (d > 2) return "{…}";
    const keys = Object.keys(v);
    if (!keys.length) return "{}";
    return "{ " + keys.map((k) => `${k}: ${inspect(v[k], true, d + 1)}`).join(", ") + " }";
  }
  return String(v);
}

// --- Préemption ------------------------------------------------------------------
function* fuel(I) {
  if (--I.fuel <= 0) {
    I.fuel = FUEL;
    yield SYS.yield();
  }
}

// --- Accès membres (avec garde sandbox) -------------------------------------------
function toKey(v) {
  return typeof v === "number" ? v : String(v);
}

function getMember(obj, key) {
  if (obj == null)
    throw ierr("TypeError", `Cannot read properties of ${obj} (reading '${key}')`);
  if (typeof key === "string" && FORBIDDEN.has(key))
    throw ierr("TypeError", `accès interdit : '${key}'`);
  if (obj.__fn) {
    if (key === "prototype") {
      if (!obj.protoObj) obj.protoObj = {};
      return obj.protoObj;
    }
    if (key === "name") return obj.name || "";
    return undefined;
  }
  if (key === "prototype" && typeof obj === "function")
    throw ierr("TypeError", "accès interdit : 'prototype'");
  return obj[key];
}

function setMember(obj, key, v) {
  if (obj == null) throw ierr("TypeError", `Cannot set properties of ${obj}`);
  if (typeof key === "string" && (FORBIDDEN.has(key) || key === "prototype") && !obj.__fn)
    throw ierr("TypeError", `accès interdit : '${key}'`);
  if (obj.__fn) {
    if (key === "prototype") obj.protoObj = v;
    return v;
  }
  obj[key] = v;
  return v;
}

// --- Opérateurs -------------------------------------------------------------------
function applyBin(op, a, b) {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return a / b;
    case "%": return a % b;
    case "**": return a ** b;
    case "==": return a == b;
    case "!=": return a != b;
    case "===": return a === b;
    case "!==": return a !== b;
    case "<": return a < b;
    case ">": return a > b;
    case "<=": return a <= b;
    case ">=": return a >= b;
    case "&": return a & b;
    case "|": return a | b;
    case "^": return a ^ b;
    case "<<": return a << b;
    case ">>": return a >> b;
    case ">>>": return a >>> b;
  }
  throw ierr("SyntaxError", `opérateur inconnu '${op}'`);
}

// --- Appels ------------------------------------------------------------------------
const isFn = (v) => !!(v && v.__fn);

function* callFn(I, f, args, thisArg, name) {
  yield* fuel(I);
  if (isFn(f)) {
    if (f.host) return yield* f.host(args, thisArg);
    if (++I.depth > MAX_DEPTH) {
      I.depth--;
      throw ierr("RangeError", "Maximum call stack size exceeded");
    }
    try {
      const node = f.node;
      const s = new Scope(f.scope);
      if (!node.isArrow) {
        s.hasThis = true;
        s.thisVal = thisArg;
      }
      // Liaison des paramètres (défauts + ...rest).
      for (let i = 0; i < node.params.length; i++) {
        const prm = node.params[i];
        if (prm.rest) {
          s.declare(prm.name, args.slice(i), "let");
          break;
        }
        let v = args[i];
        if (v === undefined && prm.def) v = yield* evalExpr(I, prm.def, s);
        s.declare(prm.name, v, "let");
      }
      if (node.exprBody) return yield* evalExpr(I, node.body, s);
      const r = yield* runBody(I, node.body, s, false);
      return r && r.flow === "return" ? r.v : undefined;
    } finally {
      I.depth--;
    }
  }
  if (typeof f === "function") {
    try {
      return f.apply(thisArg, args);
    } catch (e) {
      throw e instanceof Error ? new Thrown({ name: e.name, message: e.message }) : e;
    }
  }
  throw ierr("TypeError", `${name || "l'expression"} is not a function`);
}

// Méthodes de tableau à rappel : interceptées pour pouvoir rappeler des
// fermetures interprétées (une fonction native ne peut pas les invoquer).
const ARRAY_HOF = {
  *map(I, arr, [f]) {
    const out = [];
    for (let i = 0; i < arr.length; i++) out.push(yield* callFn(I, f, [arr[i], i, arr]));
    return out;
  },
  *filter(I, arr, [f]) {
    const out = [];
    for (let i = 0; i < arr.length; i++) if (yield* callFn(I, f, [arr[i], i, arr])) out.push(arr[i]);
    return out;
  },
  *forEach(I, arr, [f]) {
    for (let i = 0; i < arr.length; i++) yield* callFn(I, f, [arr[i], i, arr]);
  },
  *find(I, arr, [f]) {
    for (let i = 0; i < arr.length; i++) if (yield* callFn(I, f, [arr[i], i, arr])) return arr[i];
    return undefined;
  },
  *findIndex(I, arr, [f]) {
    for (let i = 0; i < arr.length; i++) if (yield* callFn(I, f, [arr[i], i, arr])) return i;
    return -1;
  },
  *some(I, arr, [f]) {
    for (let i = 0; i < arr.length; i++) if (yield* callFn(I, f, [arr[i], i, arr])) return true;
    return false;
  },
  *every(I, arr, [f]) {
    for (let i = 0; i < arr.length; i++) if (!(yield* callFn(I, f, [arr[i], i, arr]))) return false;
    return true;
  },
  *reduce(I, arr, [f, init]) {
    let acc = init, start = 0;
    if (acc === undefined) {
      if (!arr.length) throw ierr("TypeError", "Reduce of empty array with no initial value");
      acc = arr[0];
      start = 1;
    }
    for (let i = start; i < arr.length; i++) acc = yield* callFn(I, f, [acc, arr[i], i, arr]);
    return acc;
  },
  *sort(I, arr, [f]) {
    // tri par insertion avec comparateur interprété
    for (let i = 1; i < arr.length; i++) {
      const key = arr[i];
      let j = i - 1;
      while (j >= 0 && (yield* callFn(I, f, [arr[j], key])) > 0) {
        arr[j + 1] = arr[j];
        j--;
      }
      arr[j + 1] = key;
    }
    return arr;
  },
};

// --- Évaluation des statements ---------------------------------------------------
const BRK = { flow: "break" };
const CONT = { flow: "continue" };

// Exécute une liste de statements (avec hissage des déclarations de fonctions).
function* runBody(I, body, scope, trackLast) {
  for (const st of body)
    if (st.k === "fndecl")
      scope.declare(st.name, { __fn: true, node: st.fn, scope, name: st.name }, "let");
  for (const st of body) {
    if (st.k === "fndecl") continue;
    const r = yield* evalStmt(I, st, scope);
    if (r) return r;
    if (trackLast && st.k === "expr") I.lastVal = I._exprVal;
  }
  return undefined;
}

function* evalStmt(I, node, scope) {
  yield* fuel(I);
  switch (node.k) {
    case "expr":
      I._exprVal = yield* evalExpr(I, node.e, scope);
      return undefined;
    case "var": {
      for (const d of node.decls) {
        const v = d.init ? yield* evalExpr(I, d.init, scope) : undefined;
        scope.declare(d.name, v, node.kind === "const" ? "const" : "let");
      }
      return undefined;
    }
    case "block":
      return yield* runBody(I, node.body, new Scope(scope), false);
    case "if": {
      if (yield* evalExpr(I, node.c, scope)) return yield* evalStmt(I, node.t, scope);
      if (node.e) return yield* evalStmt(I, node.e, scope);
      return undefined;
    }
    case "while": {
      for (;;) {
        yield* fuel(I);
        if (!(yield* evalExpr(I, node.c, scope))) break;
        const r = yield* evalStmt(I, node.body, scope);
        if (r === BRK) break;
        if (r && r.flow === "return") return r;
      }
      return undefined;
    }
    case "dowhile": {
      for (;;) {
        yield* fuel(I);
        const r = yield* evalStmt(I, node.body, scope);
        if (r === BRK) break;
        if (r && r.flow === "return") return r;
        if (!(yield* evalExpr(I, node.c, scope))) break;
      }
      return undefined;
    }
    case "forc": {
      const s = new Scope(scope);
      if (node.init) yield* evalStmt(I, node.init, s);
      for (;;) {
        yield* fuel(I);
        if (node.c && !(yield* evalExpr(I, node.c, s))) break;
        const r = yield* evalStmt(I, node.body, s);
        if (r === BRK) break;
        if (r && r.flow === "return") return r;
        if (node.upd) yield* evalExpr(I, node.upd, s);
      }
      return undefined;
    }
    case "forof": {
      const obj = yield* evalExpr(I, node.obj, scope);
      let items;
      if (node.isIn) {
        if (obj == null) throw ierr("TypeError", "for-in sur null/undefined");
        items = Object.keys(obj);
      } else if (Array.isArray(obj) || typeof obj === "string") {
        items = obj;
      } else {
        throw ierr("TypeError", "la valeur n'est pas itérable (tableau ou chaîne attendus)");
      }
      for (const v of items) {
        yield* fuel(I);
        const s = new Scope(scope);
        s.declare(node.name, v, node.kind === "const" ? "const" : "let");
        const r = yield* evalStmt(I, node.body, s);
        if (r === BRK) break;
        if (r && r.flow === "return") return r;
      }
      return undefined;
    }
    case "ret":
      return { flow: "return", v: node.arg ? yield* evalExpr(I, node.arg, scope) : undefined };
    case "brk":
      return BRK;
    case "cont":
      return CONT;
    case "throw":
      throw new Thrown(yield* evalExpr(I, node.arg, scope));
    case "try": {
      let comp, err = null;
      try {
        comp = yield* runBody(I, node.block, new Scope(scope), false);
      } catch (e) {
        err = e;
      }
      if (err && node.handler) {
        const s = new Scope(scope);
        if (node.param) s.declare(node.param, toCatchable(err), "let");
        err = null;
        try {
          comp = yield* runBody(I, node.handler, s, false);
        } catch (e2) {
          err = e2;
        }
      }
      if (node.finalizer) {
        const f = yield* runBody(I, node.finalizer, new Scope(scope), false);
        if (f) { comp = f; err = null; } // un flux abrupt du finally l'emporte
      }
      if (err) throw err;
      return comp;
    }
    case "empty":
    case "fndecl":
      return undefined;
  }
  throw ierr("SyntaxError", `statement inconnu '${node.k}'`);
}

// --- Évaluation des expressions ------------------------------------------------
function* evalArgs(I, nodes, scope) {
  const out = [];
  for (const n of nodes) out.push(yield* evalExpr(I, n, scope));
  return out;
}

function* evalExpr(I, node, scope) {
  switch (node.k) {
    case "num": case "str": case "bool":
      return node.v;
    case "nullk":
      return null;
    case "undef":
      return undefined;
    case "this":
      return scope.getThis();
    case "id":
      return scope.get(node.name);
    case "tpl": {
      let s = node.chunks[0];
      for (let i = 0; i < node.exprs.length; i++) {
        const v = yield* evalExpr(I, node.exprs[i], scope);
        s += (typeof v === "string" ? v : inspect(v, false)) + node.chunks[i + 1];
      }
      return s;
    }
    case "arr":
      return yield* evalArgs(I, node.els, scope);
    case "obj": {
      const o = {};
      for (const p of node.props) {
        const key = p.computed ? toKey(yield* evalExpr(I, p.key, scope)) : p.key;
        if (typeof key === "string" && FORBIDDEN.has(key))
          throw ierr("TypeError", `clé interdite : '${key}'`);
        o[key] = p.value.k === "fn"
          ? { __fn: true, node: p.value, scope, name: p.value.name || String(key) }
          : yield* evalExpr(I, p.value, scope);
      }
      return o;
    }
    case "fn":
      return { __fn: true, node, scope, name: node.name };
    case "member": {
      const obj = yield* evalExpr(I, node.obj, scope);
      const key = node.computed ? toKey(yield* evalExpr(I, node.prop, scope)) : node.prop;
      return getMember(obj, key);
    }
    case "call": {
      const callee = node.callee;
      if (callee.k === "member") {
        const obj = yield* evalExpr(I, callee.obj, scope);
        const key = callee.computed ? toKey(yield* evalExpr(I, callee.prop, scope)) : callee.prop;
        const args = yield* evalArgs(I, node.args, scope);
        if (Array.isArray(obj) && ARRAY_HOF[key] && args.some(isFn))
          return yield* ARRAY_HOF[key](I, obj, args);
        const f = getMember(obj, key);
        return yield* callFn(I, f, args, obj, String(key));
      }
      const f = yield* evalExpr(I, callee, scope);
      const args = yield* evalArgs(I, node.args, scope);
      return yield* callFn(I, f, args, undefined, callee.k === "id" ? callee.name : "");
    }
    case "new": {
      const f = yield* evalExpr(I, node.callee, scope);
      const args = yield* evalArgs(I, node.args, scope);
      if (isFn(f)) {
        if (f.host) {
          const r = yield* f.host(args, undefined);
          return r && typeof r === "object" ? r : {};
        }
        if (!f.protoObj) f.protoObj = {};
        const obj = Object.create(f.protoObj);
        const r = yield* callFn(I, f, args, obj, f.name);
        return r && typeof r === "object" ? r : obj;
      }
      if (typeof f === "function") {
        try {
          return Reflect.construct(f, args);
        } catch (e) {
          throw e instanceof Error ? new Thrown({ name: e.name, message: e.message }) : e;
        }
      }
      throw ierr("TypeError", "new sur une valeur non constructible");
    }
    case "unary": {
      if (node.op === "typeof") {
        if (node.arg.k === "id" && !scope.has(node.arg.name)) return "undefined";
        const v = yield* evalExpr(I, node.arg, scope);
        return isFn(v) ? "function" : typeof v;
      }
      if (node.op === "delete") {
        if (node.arg.k !== "member") return true;
        const obj = yield* evalExpr(I, node.arg.obj, scope);
        const key = node.arg.computed
          ? toKey(yield* evalExpr(I, node.arg.prop, scope))
          : node.arg.prop;
        if (typeof key === "string" && FORBIDDEN.has(key))
          throw ierr("TypeError", `accès interdit : '${key}'`);
        if (obj && typeof obj === "object") delete obj[key];
        return true;
      }
      const v = yield* evalExpr(I, node.arg, scope);
      switch (node.op) {
        case "!": return !v;
        case "-": return -v;
        case "+": return +v;
        case "~": return ~v;
      }
      break;
    }
    case "update": {
      const delta = node.op === "++" ? 1 : -1;
      if (node.arg.k === "id") {
        const old = Number(scope.get(node.arg.name));
        scope.set(node.arg.name, old + delta);
        return node.prefix ? old + delta : old;
      }
      const obj = yield* evalExpr(I, node.arg.obj, scope);
      const key = node.arg.computed
        ? toKey(yield* evalExpr(I, node.arg.prop, scope))
        : node.arg.prop;
      const old = Number(getMember(obj, key));
      setMember(obj, key, old + delta);
      return node.prefix ? old + delta : old;
    }
    case "bin": {
      const l = yield* evalExpr(I, node.l, scope);
      const r = yield* evalExpr(I, node.r, scope);
      return applyBin(node.op, l, r);
    }
    case "logic": {
      const l = yield* evalExpr(I, node.l, scope);
      if (node.op === "&&") return l ? yield* evalExpr(I, node.r, scope) : l;
      if (node.op === "||") return l ? l : yield* evalExpr(I, node.r, scope);
      return l == null ? yield* evalExpr(I, node.r, scope) : l; // ??
    }
    case "cond":
      return (yield* evalExpr(I, node.c, scope))
        ? yield* evalExpr(I, node.t, scope)
        : yield* evalExpr(I, node.e, scope);
    case "assign": {
      if (node.target.k === "id") {
        let v = yield* evalExpr(I, node.value, scope);
        if (node.op !== "=") v = applyBin(node.op.slice(0, -1), scope.get(node.target.name), v);
        return scope.set(node.target.name, v);
      }
      const obj = yield* evalExpr(I, node.target.obj, scope);
      const key = node.target.computed
        ? toKey(yield* evalExpr(I, node.target.prop, scope))
        : node.target.prop;
      let v = yield* evalExpr(I, node.value, scope);
      if (node.op !== "=") v = applyBin(node.op.slice(0, -1), getMember(obj, key), v);
      return setMember(obj, key, v);
    }
  }
  throw ierr("SyntaxError", `expression inconnue '${node.k}'`);
}

// ===========================================================================
// Runtime : globals « node-like » construits au-dessus des syscalls.
// ===========================================================================
function stripShebang(src) {
  return src.startsWith("#!") ? src.slice(src.indexOf("\n") + 1) : src;
}

export function createInterp(ctx, { argv = ["js"], dir = "/" } = {}) {
  const I = {
    ctx,
    fuel: FUEL,
    depth: 0,
    cache: new Map(), // modules require()és : chemin absolu -> { exports }
    dirStack: [dir], // répertoire du module en cours (résolution des ./)
    global: new Scope(null),
    replScope: null,
    lastVal: undefined,
    _exprVal: undefined,
  };

  const H = (name, g) => ({ __fn: true, host: g, name });
  const fsErr = (fn, p, code) => catchable("Error", `${fn} '${p}': ${strerror(code)}`);

  // Lit un fichier entier via les syscalls (pour require et fs.readFile).
  function* slurpFile(p) {
    const fd = yield SYS.open(p, "r");
    if (typeof fd === "number" && fd < 0) return { err: fd };
    let s = "", c;
    for (;;) {
      c = yield SYS.read(fd, 4096);
      if (c === null) break;
      if (typeof c === "number") {
        yield SYS.close(fd);
        return { err: c };
      }
      s += c;
    }
    yield SYS.close(fd);
    return { data: s };
  }

  // --- console ---
  const consoleObj = {
    log: H("log", function* (args) {
      yield SYS.write(1, args.map((a) => inspect(a, typeof a !== "string")).join(" ") + "\n");
    }),
    error: H("error", function* (args) {
      yield SYS.write(2, args.map((a) => inspect(a, typeof a !== "string")).join(" ") + "\n");
    }),
  };
  consoleObj.warn = consoleObj.error;
  consoleObj.info = consoleObj.log;

  // --- process ---
  const processObj = {
    argv,
    env: { ...ctx.env },
    pid: ctx.pid,
    platform: "linucraft",
    exit: H("exit", function* (a) {
      yield SYS.exit(a[0] | 0);
    }),
    cwd: H("cwd", function* () {
      return yield SYS.getcwd();
    }),
    chdir: H("chdir", function* (a) {
      const r = yield SYS.chdir(String(a[0]));
      if (r < 0) throw fsErr("chdir", a[0], r);
    }),
  };

  // --- module fs (style node, version synchrone) ---
  const fsMod = {
    readFile: H("readFile", function* (a) {
      const r = yield* slurpFile(String(a[0]));
      if (r.err !== undefined) throw fsErr("readFile", a[0], r.err);
      return r.data;
    }),
    writeFile: H("writeFile", function* (a) {
      const fd = yield SYS.open(String(a[0]), "w");
      if (typeof fd === "number" && fd < 0) throw fsErr("writeFile", a[0], fd);
      yield SYS.write(fd, String(a[1] ?? ""));
      yield SYS.close(fd);
    }),
    appendFile: H("appendFile", function* (a) {
      const fd = yield SYS.open(String(a[0]), "a");
      if (typeof fd === "number" && fd < 0) throw fsErr("appendFile", a[0], fd);
      yield SYS.write(fd, String(a[1] ?? ""));
      yield SYS.close(fd);
    }),
    readdir: H("readdir", function* (a) {
      const r = yield SYS.readdir(String(a[0]));
      if (typeof r === "number") throw fsErr("readdir", a[0], r);
      return r;
    }),
    mkdir: H("mkdir", function* (a) {
      const r = yield SYS.mkdir(String(a[0]));
      if (r < 0) throw fsErr("mkdir", a[0], r);
    }),
    rm: H("rm", function* (a) {
      const r = yield SYS.unlink(String(a[0]), !!a[1]);
      if (r < 0) throw fsErr("rm", a[0], r);
    }),
    exists: H("exists", function* (a) {
      return (yield SYS.stat(String(a[0]))) !== null;
    }),
    stat: H("stat", function* (a) {
      const st = yield SYS.lstat(String(a[0]));
      if (!st) throw fsErr("stat", a[0], -2);
      return st;
    }),
  };

  // --- module os ---
  const osMod = {
    platform: () => "linucraft",
    hostname: () => "linucraft",
    uptime: H("uptime", function* () {
      const r = yield* slurpFile("/proc/uptime");
      return r.data ? Number(r.data) / 20 : 0;
    }),
    sleep: H("sleep", function* (a) {
      const ms = Number(a[0]) || 0;
      yield SYS.sleep(Math.max(1, Math.round(ms / 50)));
    }),
  };

  const builtins = { fs: fsMod, path, os: osMod };

  // --- require ---
  const requireFn = H("require", function* (a) {
    const name = String(a[0]);
    if (builtins[name]) return builtins[name];
    if (!name.startsWith("./") && !name.startsWith("../") && !name.startsWith("/"))
      throw catchable("Error", `Cannot find module '${name}'`);
    const base = I.dirStack[I.dirStack.length - 1];
    let p = name.startsWith("/") ? path.normalize(name) : path.join(base, name);
    let st = yield SYS.stat(p);
    if (!st || st.type !== "f") {
      const st2 = yield SYS.stat(p + ".js");
      if (st2 && st2.type === "f") { p = p + ".js"; st = st2; }
    }
    if (!st || st.type !== "f") throw catchable("Error", `Cannot find module '${name}'`);
    if (I.cache.has(p)) return I.cache.get(p).exports;

    const r = yield* slurpFile(p);
    if (r.err !== undefined) throw fsErr("require", p, r.err);
    const prog = parseProgram(stripShebang(r.data)); // peut jeter une SyntaxError
    const module = { exports: {} };
    I.cache.set(p, module); // avant l'éval : gère les requires circulaires
    const scope = moduleScope(I, module, p);
    I.dirStack.push(path.dirname(p));
    try {
      yield* runBody(I, prog.body, scope, false);
    } finally {
      I.dirStack.pop();
    }
    return module.exports;
  });
  I.requireFn = requireFn;

  // --- constructeurs d'erreurs ---
  const mkErrCtor = (nm) =>
    H(nm, function* (a) {
      return { name: nm, message: a[0] === undefined ? "" : String(a[0]) };
    });

  // --- globals ---
  const g = I.global;
  g.declare("console", consoleObj, "const");
  g.declare("process", processObj, "const");
  g.declare("require", requireFn, "const");
  g.declare("Math", Math, "const");
  g.declare("JSON", JSON, "const");
  g.declare("Object", Object, "const");
  g.declare("Array", Array, "const");
  g.declare("String", String, "const");
  g.declare("Number", Number, "const");
  g.declare("Boolean", Boolean, "const");
  g.declare("Date", Date, "const");
  g.declare("parseInt", parseInt, "const");
  g.declare("parseFloat", parseFloat, "const");
  g.declare("isNaN", isNaN, "const");
  g.declare("isFinite", isFinite, "const");
  g.declare("NaN", NaN, "const");
  g.declare("Infinity", Infinity, "const");
  g.declare("Error", mkErrCtor("Error"), "const");
  g.declare("TypeError", mkErrCtor("TypeError"), "const");
  g.declare("RangeError", mkErrCtor("RangeError"), "const");

  return I;
}

function moduleScope(I, module, filename) {
  const s = new Scope(I.global);
  s.declare("module", module, "let");
  s.declare("exports", module.exports, "let");
  s.declare("require", I.requireFn, "const");
  s.declare("__filename", filename, "const");
  s.declare("__dirname", path.dirname(filename), "const");
  return s;
}

// Exécute un fichier comme module principal. Renvoie le code de sortie.
export function* runModule(I, src, filename) {
  let prog;
  try {
    prog = parseProgram(stripShebang(src));
  } catch (e) {
    yield SYS.write(2, `js: ${filename}: ${errText(e)}\n`);
    return 1;
  }
  const module = { exports: {} };
  const scope = moduleScope(I, module, filename);
  I.dirStack.push(path.dirname(filename));
  try {
    yield* runBody(I, prog.body, scope, false);
    return 0;
  } catch (e) {
    yield SYS.write(2, `js: ${filename}: ${errText(e)}\n`);
    return 1;
  } finally {
    I.dirStack.pop();
  }
}

// Évalue une ligne de REPL dans une portée persistante ; renvoie la valeur de
// la dernière expression. Les erreurs remontent à l'appelant.
export function* evalRepl(I, src) {
  const prog = parseProgram(src);
  if (!I.replScope) I.replScope = moduleScope(I, { exports: {} }, "/repl");
  I.lastVal = undefined;
  yield* runBody(I, prog.body, I.replScope, true);
  return I.lastVal;
}
