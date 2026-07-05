import { lex } from "./lexer.js";

// ---------------------------------------------------------------------------
// Parser du sous-ensemble JavaScript : tokens -> AST.
//
// Supporté : let/const/var, function/fléchées (+ closures, défauts, ...rest),
//   if/else, while, do-while, for(;;), for-of, for-in, break/continue/return,
//   throw, try/catch/finally, littéraux objet/tableau, templates `${}`,
//   opérateurs arithmétiques/logiques/bit-à-bit, ternaire, new, this, typeof,
//   delete, ++/--, affectations composées.
// Non supporté (v1) : class, destructuring, spread, regex, async/générateurs.
// ---------------------------------------------------------------------------

function synErr(msg, line) {
  const e = new Error(`${msg}${line ? ` (ligne ${line})` : ""}`);
  e.name = "SyntaxError";
  return e;
}

const PREC = {
  "??": 1, "||": 2, "&&": 3,
  "|": 4, "^": 5, "&": 6,
  "==": 7, "!=": 7, "===": 7, "!==": 7,
  "<": 8, ">": 8, "<=": 8, ">=": 8,
  "<<": 9, ">>": 9, ">>>": 9,
  "+": 10, "-": 10,
  "*": 11, "/": 11, "%": 11,
  "**": 12,
};
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%="]);

function Parser(toks) {
  let p = 0;
  const peek = (k = 0) => toks[p + k];
  const next = () => toks[p++];
  const isP = (v, k = 0) => peek(k).t === "p" && peek(k).v === v;
  const isKw = (v, k = 0) => peek(k).t === "kw" && peek(k).v === v;
  const expectP = (v) => {
    if (!isP(v)) throw synErr(`'${v}' attendu, trouvé '${tokStr(peek())}'`, peek().line);
    return next();
  };
  const expectKw = (v) => {
    if (!isKw(v)) throw synErr(`'${v}' attendu, trouvé '${tokStr(peek())}'`, peek().line);
    return next();
  };
  const tokStr = (t) => (t.t === "eof" ? "fin de fichier" : t.v ?? t.t);

  // Point-virgule avec insertion automatique (ASI).
  function semi() {
    if (isP(";")) { next(); return; }
    const t = peek();
    if (t.t === "eof" || isP("}") || t.nl) return;
    throw synErr(`';' attendu, trouvé '${tokStr(t)}'`, t.line);
  }

  // --- Statements ------------------------------------------------------------
  function parseStatements(endP) {
    const body = [];
    while (peek().t !== "eof" && !(endP && isP(endP))) body.push(parseStatement());
    return body;
  }

  function parseStatement() {
    const t = peek();
    if (t.t === "kw") {
      switch (t.v) {
        case "let": case "const": case "var": {
          const node = parseVarDecl();
          semi();
          return node;
        }
        case "function": {
          next();
          const name = expectId();
          const fn = parseFunctionRest(name);
          return { k: "fndecl", name, fn };
        }
        case "if": return parseIf();
        case "while": {
          next();
          expectP("(");
          const c = parseExpr();
          expectP(")");
          return { k: "while", c, body: parseStatement() };
        }
        case "do": {
          next();
          const body = parseStatement();
          expectKw("while");
          expectP("(");
          const c = parseExpr();
          expectP(")");
          semi();
          return { k: "dowhile", c, body };
        }
        case "for": return parseFor();
        case "return": {
          next();
          let arg = null;
          if (!isP(";") && !isP("}") && peek().t !== "eof" && !peek().nl) arg = parseExpr();
          semi();
          return { k: "ret", arg };
        }
        case "break": next(); semi(); return { k: "brk" };
        case "continue": next(); semi(); return { k: "cont" };
        case "throw": {
          next();
          const arg = parseExpr();
          semi();
          return { k: "throw", arg };
        }
        case "try": return parseTry();
      }
    }
    if (isP("{")) {
      next();
      const body = parseStatements("}");
      expectP("}");
      return { k: "block", body };
    }
    if (isP(";")) { next(); return { k: "empty" }; }
    const e = parseExpr();
    semi();
    return { k: "expr", e };
  }

  function expectId() {
    const t = peek();
    if (t.t !== "id") throw synErr(`identifiant attendu, trouvé '${tokStr(t)}'`, t.line);
    return next().v;
  }

  function parseVarDecl() {
    const kind = next().v; // let/const/var
    const decls = [];
    for (;;) {
      const name = expectId();
      let init = null;
      if (isP("=")) { next(); init = parseAssign(); }
      decls.push({ name, init });
      if (!isP(",")) break;
      next();
    }
    return { k: "var", kind, decls };
  }

  function parseIf() {
    expectKw("if");
    expectP("(");
    const c = parseExpr();
    expectP(")");
    const t = parseStatement();
    let e = null;
    if (isKw("else")) { next(); e = parseStatement(); }
    return { k: "if", c, t, e };
  }

  function parseFor() {
    expectKw("for");
    expectP("(");
    // for-of / for-in : `for (let x of e)` / `for (x in e)`
    let kind = null, declPos = p;
    if (isKw("let") || isKw("const") || isKw("var")) { kind = next().v; }
    if (peek().t === "id" && (isKw("in", 1) || (peek(1).t === "id" && peek(1).v === "of"))) {
      const name = next().v;
      const isIn = peek().t === "kw"; // "in" est un mot-clé, "of" un identifiant
      next();
      const obj = parseExpr();
      expectP(")");
      return { k: "forof", kind: kind || "let", name, obj, body: parseStatement(), isIn };
    }
    p = declPos; // pas un for-of : on rembobine (le kind éventuel sera relu)
    let init = null;
    if (!isP(";")) init = isKw("let") || isKw("const") || isKw("var") ? parseVarDecl() : { k: "expr", e: parseExpr() };
    expectP(";");
    const c = isP(";") ? null : parseExpr();
    expectP(";");
    const upd = isP(")") ? null : parseExpr();
    expectP(")");
    return { k: "forc", init, c, upd, body: parseStatement() };
  }

  function parseTry() {
    expectKw("try");
    expectP("{");
    const block = parseStatements("}");
    expectP("}");
    let param = null, handler = null, finalizer = null;
    if (isKw("catch")) {
      next();
      if (isP("(")) { next(); param = expectId(); expectP(")"); }
      expectP("{");
      handler = parseStatements("}");
      expectP("}");
    }
    if (isKw("finally")) {
      next();
      expectP("{");
      finalizer = parseStatements("}");
      expectP("}");
    }
    if (!handler && !finalizer) throw synErr("catch ou finally attendu après try", peek().line);
    return { k: "try", block, param, handler, finalizer };
  }

  // --- Fonctions ---------------------------------------------------------------
  function parseParams() {
    expectP("(");
    const params = [];
    while (!isP(")")) {
      if (isP(".")) { // rest : trois '.' successifs
        expectP(".");
        expectP(".");
        expectP(".");
        params.push({ name: expectId(), rest: true });
      } else {
        const name = expectId();
        let def = null;
        if (isP("=")) { next(); def = parseAssign(); }
        params.push({ name, def });
      }
      if (!isP(",")) break;
      next();
    }
    expectP(")");
    return params;
  }

  function parseFunctionRest(name) {
    const params = parseParams();
    expectP("{");
    const body = parseStatements("}");
    expectP("}");
    return { k: "fn", name, params, body, isArrow: false, exprBody: false };
  }

  function parseArrowAfterParams(params) {
    expectP("=>");
    if (isP("{")) {
      next();
      const body = parseStatements("}");
      expectP("}");
      return { k: "fn", name: "", params, body, isArrow: true, exprBody: false };
    }
    return { k: "fn", name: "", params, body: parseAssign(), isArrow: true, exprBody: true };
  }

  // Regarde si '(' ouvre une liste de paramètres de fléchée : on scanne jusqu'à
  // la parenthèse fermante appariée et on vérifie le '=>' qui suit.
  function isArrowParen() {
    let depth = 0, k = p;
    for (; k < toks.length; k++) {
      const t = toks[k];
      if (t.t === "p" && t.v === "(") depth++;
      else if (t.t === "p" && t.v === ")") {
        depth--;
        if (depth === 0) break;
      } else if (t.t === "eof") return false;
    }
    const after = toks[k + 1];
    return after && after.t === "p" && after.v === "=>";
  }

  // --- Expressions ---------------------------------------------------------------
  function parseExpr() {
    return parseAssign();
  }

  function parseAssign() {
    // fléchée à un paramètre nu : x => ...
    if (peek().t === "id" && isP("=>", 1)) {
      const name = next().v;
      return parseArrowAfterParams([{ name }]);
    }
    // fléchée parenthésée : (a, b = 1, ...r) => ...
    if (isP("(") && isArrowParen()) {
      const params = parseParams();
      return parseArrowAfterParams(params);
    }
    const left = parseTernary();
    const t = peek();
    if (t.t === "p" && ASSIGN_OPS.has(t.v)) {
      if (left.k !== "id" && left.k !== "member")
        throw synErr("cible d'affectation invalide", t.line);
      next();
      return { k: "assign", op: t.v, target: left, value: parseAssign() };
    }
    return left;
  }

  function parseTernary() {
    const c = parseBin(1);
    if (!isP("?")) return c;
    next();
    const t = parseAssign();
    expectP(":");
    return { k: "cond", c, t, e: parseAssign() };
  }

  function parseBin(min) {
    let l = parseUnary();
    for (;;) {
      const t = peek();
      if (t.t !== "p" || !(t.v in PREC) || PREC[t.v] < min) break;
      const op = next().v;
      // ** est associatif à droite
      const r = parseBin(op === "**" ? PREC[op] : PREC[op] + 1);
      l = { k: op === "&&" || op === "||" || op === "??" ? "logic" : "bin", op, l, r };
    }
    return l;
  }

  function parseUnary() {
    const t = peek();
    if (t.t === "p" && (t.v === "!" || t.v === "-" || t.v === "+" || t.v === "~")) {
      next();
      return { k: "unary", op: t.v, arg: parseUnary() };
    }
    if (isKw("typeof")) { next(); return { k: "unary", op: "typeof", arg: parseUnary() }; }
    if (isKw("delete")) { next(); return { k: "unary", op: "delete", arg: parseUnary() }; }
    if (t.t === "p" && (t.v === "++" || t.v === "--")) {
      next();
      const arg = parseUnary();
      if (arg.k !== "id" && arg.k !== "member") throw synErr("cible de ++/-- invalide", t.line);
      return { k: "update", op: t.v, prefix: true, arg };
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let e = parseCallMember(parsePrimary());
    const t = peek();
    if (t.t === "p" && (t.v === "++" || t.v === "--") && !t.nl &&
        (e.k === "id" || e.k === "member")) {
      next();
      e = { k: "update", op: t.v, prefix: false, arg: e };
    }
    return e;
  }

  function parseArgs() {
    expectP("(");
    const args = [];
    while (!isP(")")) {
      args.push(parseAssign());
      if (!isP(",")) break;
      next();
    }
    expectP(")");
    return args;
  }

  function parseCallMember(base, noCall = false) {
    for (;;) {
      if (isP(".")) {
        next();
        const t = peek();
        if (t.t !== "id" && t.t !== "kw") throw synErr("nom de propriété attendu", t.line);
        next();
        base = { k: "member", obj: base, prop: t.v, computed: false };
      } else if (isP("[")) {
        next();
        const prop = parseExpr();
        expectP("]");
        base = { k: "member", obj: base, prop, computed: true };
      } else if (isP("(") && !noCall) {
        base = { k: "call", callee: base, args: parseArgs() };
      } else break;
    }
    return base;
  }

  function parsePrimary() {
    const t = peek();
    if (t.t === "num") { next(); return { k: "num", v: t.v }; }
    if (t.t === "str") { next(); return { k: "str", v: t.v }; }
    if (t.t === "tpl") {
      next();
      return { k: "tpl", chunks: t.chunks, exprs: t.exprs.map((src) => parseExpression(src)) };
    }
    if (t.t === "kw") {
      switch (t.v) {
        case "true": next(); return { k: "bool", v: true };
        case "false": next(); return { k: "bool", v: false };
        case "null": next(); return { k: "nullk" };
        case "undefined": next(); return { k: "undef" };
        case "this": next(); return { k: "this" };
        case "function": {
          next();
          const name = peek().t === "id" ? next().v : "";
          return parseFunctionRest(name);
        }
        case "new": {
          next();
          const callee = parseCallMember(parsePrimary(), true);
          const args = isP("(") ? parseArgs() : [];
          return { k: "new", callee, args };
        }
      }
    }
    if (t.t === "id") { next(); return { k: "id", name: t.v }; }
    if (isP("(")) {
      next();
      const e = parseExpr();
      expectP(")");
      return e;
    }
    if (isP("[")) {
      next();
      const els = [];
      while (!isP("]")) {
        els.push(parseAssign());
        if (!isP(",")) break;
        next();
      }
      expectP("]");
      return { k: "arr", els };
    }
    if (isP("{")) {
      next();
      const props = [];
      while (!isP("}")) {
        let key, computed = false;
        const kt = peek();
        if (isP("[")) { next(); key = parseExpr(); computed = true; expectP("]"); }
        else if (kt.t === "id" || kt.t === "kw") { next(); key = kt.v; }
        else if (kt.t === "str" || kt.t === "num") { next(); key = String(kt.v); }
        else throw synErr("clé d'objet attendue", kt.line);

        let value;
        if (isP("(")) {
          // méthode raccourcie : { m(a) { … } }
          value = parseFunctionRest(typeof key === "string" ? key : "");
        } else if (isP(":")) {
          next();
          value = parseAssign();
        } else {
          // raccourci : { a }
          if (computed || kt.t !== "id") throw synErr("':' attendu", kt.line);
          value = { k: "id", name: key };
        }
        props.push({ key, computed, value });
        if (!isP(",")) break;
        next();
      }
      expectP("}");
      return { k: "obj", props };
    }
    throw synErr(`expression attendue, trouvé '${tokStr(t)}'`, t.line);
  }

  return {
    program() {
      const body = parseStatements(null);
      if (peek().t !== "eof") throw synErr(`inattendu : '${tokStr(peek())}'`, peek().line);
      return { k: "prog", body };
    },
    expression() {
      const e = parseExpr();
      if (peek().t !== "eof") throw synErr(`inattendu : '${tokStr(peek())}'`, peek().line);
      return e;
    },
  };
}

export function parseProgram(src) {
  return Parser(lex(src)).program();
}

export function parseExpression(src) {
  return Parser(lex(src)).expression();
}
