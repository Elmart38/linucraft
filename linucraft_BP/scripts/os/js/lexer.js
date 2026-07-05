// ---------------------------------------------------------------------------
// Lexer du sous-ensemble JavaScript de linucraft.
// Produit des tokens : {t:"num"|"str"|"tpl"|"id"|"kw"|"p"|"eof", v, nl, line}
//   nl = true si le token est précédé d'un saut de ligne (pour l'ASI).
// ---------------------------------------------------------------------------

export const KEYWORDS = new Set([
  "let", "const", "var", "function", "return", "if", "else", "while", "do",
  "for", "in", "break", "continue", "true", "false", "null", "undefined",
  "new", "typeof", "delete", "throw", "try", "catch", "finally", "this",
]);

function synErr(msg, line) {
  const e = new Error(`${msg} (ligne ${line})`);
  e.name = "SyntaxError";
  return e;
}

function readString(src, i, q, line) {
  let j = i + 1, s = "";
  while (j < src.length && src[j] !== q) {
    if (src[j] === "\n") throw synErr("chaîne non terminée", line);
    if (src[j] === "\\") {
      const e = src[j + 1];
      if (e === "n") s += "\n";
      else if (e === "t") s += "\t";
      else if (e === "r") s += "\r";
      else if (e === "0") s += "\0";
      else s += e; // \\ \' \" \` et le reste : littéral
      j += 2;
    } else s += src[j++];
  }
  if (j >= src.length) throw synErr("chaîne non terminée", line);
  return { s, end: j + 1 };
}

// Template : `texte ${expr} texte` -> chunks (textes) + exprs (sources brutes).
function readTemplate(src, i, line) {
  let j = i + 1, cur = "", lines = 0;
  const chunks = [], exprs = [];
  while (j < src.length && src[j] !== "`") {
    if (src[j] === "\\") {
      const e = src[j + 1];
      cur += e === "n" ? "\n" : e === "t" ? "\t" : e;
      j += 2;
      continue;
    }
    if (src[j] === "$" && src[j + 1] === "{") {
      chunks.push(cur);
      cur = "";
      let depth = 1, k = j + 2, ex = "";
      while (k < src.length && depth > 0) {
        const ch = src[k];
        if (ch === "'" || ch === '"') {
          const r = readString(src, k, ch, line + lines);
          ex += src.slice(k, r.end);
          k = r.end;
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (!depth) break; }
        if (ch === "\n") lines++;
        ex += ch;
        k++;
      }
      if (depth) throw synErr("${ non fermé dans un template", line + lines);
      exprs.push(ex);
      j = k + 1;
      continue;
    }
    if (src[j] === "\n") lines++;
    cur += src[j++];
  }
  if (j >= src.length) throw synErr("template non terminé", line);
  chunks.push(cur);
  return { chunks, exprs, end: j + 1, lines };
}

export function lex(src) {
  const toks = [];
  let i = 0, line = 1, nl = false;
  const push = (t) => {
    t.nl = nl;
    t.line = line;
    toks.push(t);
    nl = false;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === "\n") { line++; nl = true; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") { line++; nl = true; }
        i++;
      }
      i += 2;
      continue;
    }

    // nombres (décimal, flottant, hexa 0x)
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        let j = i + 2;
        while (/[0-9a-fA-F]/.test(src[j] || "")) j++;
        push({ t: "num", v: parseInt(src.slice(i, j), 16) });
        i = j;
        continue;
      }
      let j = i;
      while (/[0-9]/.test(src[j] || "")) j++;
      if (src[j] === ".") { j++; while (/[0-9]/.test(src[j] || "")) j++; }
      if (src[j] === "e" || src[j] === "E") {
        j++;
        if (src[j] === "+" || src[j] === "-") j++;
        while (/[0-9]/.test(src[j] || "")) j++;
      }
      push({ t: "num", v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }

    if (c === "'" || c === '"') {
      const r = readString(src, i, c, line);
      push({ t: "str", v: r.s });
      i = r.end;
      continue;
    }
    if (c === "`") {
      const r = readTemplate(src, i, line);
      push({ t: "tpl", chunks: r.chunks, exprs: r.exprs });
      line += r.lines;
      i = r.end;
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const w = src.slice(i, j);
      push(KEYWORDS.has(w) ? { t: "kw", v: w } : { t: "id", v: w });
      i = j;
      continue;
    }

    // ponctuation (plus long d'abord)
    const three = src.slice(i, i + 3);
    if (three === "===" || three === "!==" || three === ">>>") { push({ t: "p", v: three }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||", "??", "=>", "++", "--",
         "+=", "-=", "*=", "/=", "%=", "**", "<<", ">>"].includes(two)) {
      push({ t: "p", v: two });
      i += 2;
      continue;
    }
    if ("+-*/%=<>!?:,;.()[]{}&|^~".includes(c)) { push({ t: "p", v: c }); i++; continue; }
    throw synErr(`caractère inattendu '${c}'`, line);
  }
  push({ t: "eof" });
  return toks;
}
