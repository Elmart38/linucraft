import { createInterp, runModule, evalRepl, inspect, errText } from "../js/interp.js";

// ---------------------------------------------------------------------------
// /bin/js (alias /bin/node) — le moteur JavaScript de linucraft.
//   js fichier.js [args…]  : exécute un programme
//   js                     : REPL interactif (`.exit` pour sortir)
// Les programmes disposent de console, process, require('fs'|'path'|'os'),
// require('./module.js'), module.exports, __filename / __dirname.
// ---------------------------------------------------------------------------

export function* js(ctx) {
  const rest = ctx.argv.slice(1);
  const file = rest.find((a) => !a.startsWith("-"));

  if (!file) return yield* repl(ctx);

  const r = yield* ctx.fs.readFile(file);
  if (r.err) {
    yield ctx.sys.write(2, `js: ${file}: ${ctx.strerror(r.err)}\n`);
    return 1;
  }
  const cwd = yield ctx.sys.getcwd();
  const abs = file.startsWith("/") ? ctx.path.normalize(file) : ctx.path.join(cwd, file);
  const scriptArgs = rest.slice(rest.indexOf(file) + 1);
  const I = createInterp(ctx, {
    argv: ["js", abs, ...scriptArgs],
    dir: ctx.path.dirname(abs),
  });
  return yield* runModule(I, r.data, abs);
}

function* repl(ctx) {
  yield ctx.sys.write(1, "linucraft js 2.0 — REPL JavaScript. Tape §a.exit§r pour sortir.\n");
  const cwd = yield ctx.sys.getcwd();
  const I = createInterp(ctx, { argv: ["js"], dir: cwd });

  for (;;) {
    yield ctx.sys.write(1, "§b>§r ");
    const line = yield* ctx.readLine();
    if (line === null) break;
    yield ctx.sys.write(1, line + "\n"); // écho
    const t = line.trim();
    if (t === ".exit" || t === ".quit") break;
    if (t === "") continue;
    try {
      const v = yield* evalRepl(I, line);
      yield ctx.sys.write(1, "§7" + inspect(v, true) + "§r\n");
    } catch (e) {
      yield ctx.sys.write(2, "§c" + errText(e) + "§r\n");
    }
  }
  return 0;
}
