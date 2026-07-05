// Tests de la Phase 5 : le moteur JavaScript (/bin/js), require(), ^C et kill.
import { boot, sh, makeAsserter, settle } from "./lib.mjs";
import { splitPath } from "../linucraft_BP/scripts/os/vfs.js";

const A = makeAsserter("linucraft — Phase 5 (moteur JS)");

// Écrit un programme JS exécutable dans le home (sans passer par le shell,
// pour éviter les acrobaties d'échappement multi-lignes).
function writeJs(m, name, src) {
  m.vfs.writeFile(splitPath("/home/elwin/" + name), src, false, { m: 0o755, u: 1000, g: 1000 });
}

// --- Programme seedé ---------------------------------------------------------
{
  const m = boot();
  A.has("hello.js est seedé dans le home", sh(m, "ls"), "hello.js");
  A.has("./hello.js s'exécute (shebang js + bit x)", sh(m, "./hello.js"), "Bonjour, monde !");
  A.has("./hello.js avec argument (process.argv)", sh(m, "./hello.js Elwin"), "Bonjour, Elwin !");
  A.has("hello.js boucle for + template", sh(m, "js hello.js"), "2 × 2 = 4");
}

// --- Bases du langage --------------------------------------------------------
{
  const m = boot();
  writeJs(m, "base.js", `
    let a = 2 + 3 * 4;
    const s = "lin" + "ux";
    console.log(a, s, a > 10, \`tpl=\${a * 2}\`);
    let bits = (1 << 4) | 3;
    console.log("bits", bits, bits & 0xff, ~0 >>> 28);
  `);
  const out = sh(m, "js base.js");
  A.has("arithmétique + concat + template", out, "14 linux true tpl=28");
  A.has("opérateurs bit à bit", out, "bits 19 19 15");
}

// --- Fonctions, récursion, fermetures, fléchées ------------------------------
{
  const m = boot();
  writeJs(m, "fn.js", `
    function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
    console.log("fib", fib(15));
    function compteur() { let n = 0; return () => { n++; return n; }; }
    const c = compteur();
    c(); c();
    console.log("compteur", c());
    const carre = (x) => x * x;
    const somme = (...xs) => xs.reduce((a, b) => a + b, 0);
    console.log("carre", carre(9), "somme", somme(1, 2, 3, 4));
    function saluer(nom = "toi") { return "salut " + nom; }
    console.log(saluer(), "|", saluer("moi"));
  `);
  const out = sh(m, "js fn.js");
  A.has("récursion (fib 15)", out, "fib 610");
  A.has("fermetures (compteur)", out, "compteur 3");
  A.has("fléchées + rest + reduce", out, "carre 81 somme 10");
  A.has("paramètres par défaut", out, "salut toi | salut moi");
}

// --- Tableaux, objets, méthodes natives, HOF ---------------------------------
{
  const m = boot();
  writeJs(m, "data.js", `
    const xs = [3, 1, 2];
    console.log(xs.map((x) => x * 10).join(","));
    console.log(xs.filter((x) => x >= 2).length, xs.find((x) => x === 1));
    xs.sort((a, b) => a - b);
    console.log("tri", xs.join("<"));
    const o = { nom: "steve", hp: 20, dire() { return this.nom + "!"; } };
    o.hp += 1;
    console.log(o.dire(), o.hp, Object.keys(o).length);
    console.log(JSON.parse('{"a":5}').a, JSON.stringify({ b: [1, 2] }));
    console.log("MAJ".toLowerCase(), Math.max(4, 7), parseInt("2a", 16));
    for (const k in { x: 1, y: 2 }) console.log("cle", k);
  `);
  const out = sh(m, "js data.js");
  A.has("map + join", out, "30,10,20");
  A.has("filter/find", out, "2 1");
  A.has("sort avec comparateur interprété", out, "tri 1<2<3");
  A.has("méthodes + this", out, "steve! 21 3");
  A.has("JSON natif", out, '5 {"b":[1,2]}');
  A.has("stdlib native (String/Math/parseInt)", out, "maj 7 42");
  A.has("for-in", out, "cle x");
}

// --- Contrôle de flux, try/catch, throw --------------------------------------
{
  const m = boot();
  writeJs(m, "flow.js", `
    let s = 0;
    for (let i = 0; i < 10; i++) { if (i === 3) continue; if (i > 5) break; s += i; }
    console.log("s", s);
    let w = 0;
    while (true) { w++; if (w >= 4) break; }
    do { w++; } while (w < 6);
    console.log("w", w);
    try { JSON.parse("{pas du json"); } catch (e) { console.log("attrapé", e.name); }
    try { throw new Error("boum"); } catch (e) { console.log("err", e.message); } finally { console.log("finally"); }
    try { throw { code: 42 }; } catch (e) { console.log("objet", e.code); }
  `);
  const out = sh(m, "js flow.js");
  A.has("for + continue + break", out, "s 12");
  A.has("while/do-while", out, "w 6");
  A.has("catch d'une erreur native", out, "attrapé SyntaxError");
  A.has("throw new Error + finally", out, "err boum");
  A.has("finally exécuté", out, "finally");
  A.has("throw d'un objet", out, "objet 42");
}

// --- new / prototypes simples --------------------------------------------------
{
  const m = boot();
  writeJs(m, "proto.js", `
    function Mob(nom, hp) { this.nom = nom; this.hp = hp; }
    Mob.prototype.crier = function () { return this.nom + " (" + this.hp + " pv)"; };
    const z = new Mob("zombie", 20);
    console.log(z.crier());
    console.log(typeof Mob, typeof z, typeof z.hp);
  `);
  const out = sh(m, "js proto.js");
  A.has("new + prototype + this", out, "zombie (20 pv)");
  A.has("typeof", out, "function object number");
}

// --- Erreurs du moteur ----------------------------------------------------------
{
  const m = boot();
  writeJs(m, "bad.js", "let = 3;");
  A.has("erreur de syntaxe signalée", sh(m, "js bad.js"), "SyntaxError");
  A.eq("code de sortie 1", sh(m, "echo $?"), "1");
  writeJs(m, "ref.js", "console.log(inconnu);");
  A.has("ReferenceError", sh(m, "js ref.js"), "inconnu is not defined");
  writeJs(m, "depth.js", "function f() { return f(); } f();");
  A.has("récursion infinie détectée", sh(m, "js depth.js"), "call stack");
  writeJs(m, "evil.js", 'try { const c = ({}).constructor; } catch (e) { console.log("bloque:", e.message); }');
  A.has("sandbox : constructor bloqué", sh(m, "js evil.js"), "bloque:");
}

// --- process, exit, env ----------------------------------------------------------
{
  const m = boot();
  writeJs(m, "proc.js", `
    console.log(process.argv[2], process.env.USER, process.platform);
    process.exit(7);
    console.log("jamais");
  `);
  const out = sh(m, "js proc.js abc");
  A.has("process.argv / env", out, "abc elwin linucraft");
  A.check("process.exit coupe net", !out.includes("jamais"), `got=${JSON.stringify(out)}`);
  A.eq("code de sortie de process.exit", sh(m, "echo $?"), "7");
}

// --- Modules node-like : fs, path, os --------------------------------------------
{
  const m = boot();
  writeJs(m, "iofs.js", `
    const fs = require("fs");
    const path = require("path");
    fs.writeFile("/tmp/note.txt", "depuis js\\n");
    fs.appendFile("/tmp/note.txt", "ligne 2\\n");
    console.log("lu:", fs.readFile("/tmp/note.txt").split("\\n")[1]);
    console.log("dir:", fs.readdir("/etc").join(","));
    console.log("join:", path.join("/a", "b", "../c"));
    console.log("motd existe:", fs.exists("/etc/motd"));
  `);
  const out = sh(m, "js iofs.js");
  A.has("fs.writeFile + readFile", out, "lu: ligne 2");
  A.has("fs.readdir", out, "motd");
  A.has("path.join", out, "join: /a/c");
  A.has("fs.exists", out, "motd existe: true");
  A.eq("le fichier écrit par JS est visible du shell", sh(m, "head -1 /tmp/note.txt"), "depuis js");
}

// --- require() de modules utilisateur ---------------------------------------------
{
  const m = boot();
  writeJs(m, "lib.js", `
    console.log("init lib");
    let compteur = 0;
    exports.add = (a, b) => a + b;
    exports.tick = () => { compteur++; return compteur; };
    module.exports.PI2 = 6.28;
  `);
  writeJs(m, "app.js", `
    const lib = require("./lib.js");
    const encore = require("./lib"); // extension optionnelle + cache
    console.log("add:", lib.add(2, 3), "PI2:", lib.PI2);
    lib.tick();
    console.log("partage:", encore.tick()); // même instance => 2
    console.log("filename:", __filename);
  `);
  const out = sh(m, "js app.js");
  A.has("require + exports", out, "add: 5 PI2: 6.28");
  A.check("le module n'est initialisé qu'une fois", out.split("init lib").length === 2, `got=${JSON.stringify(out)}`);
  A.has("cache require partagé", out, "partage: 2");
  A.has("__filename", out, "filename: /home/elwin/app.js");
}

// --- Préemption : while(true) ne gèle pas le noyau --------------------------------
{
  const m = boot();
  writeJs(m, "loop.js", "#!/bin/js\nwhile (true) {}");
  const out = sh(m, "./loop.js &");
  const pid = (out.match(/^\[1\] (\d+)/) || [])[1];
  A.check("boucle infinie lancée en arrière-plan", !!pid, `got=${JSON.stringify(out)}`);
  A.eq("le shell répond pendant la boucle (préemption)", sh(m, "echo vivant"), "vivant");
  A.has("ps montre la boucle", sh(m, "ps"), "loop.js");
  A.eq("kill termine la boucle", sh(m, `kill ${pid}`), "");
  sh(m, "wait");
  A.check("plus de loop.js dans ps", !sh(m, "ps").includes("loop.js"), "encore là");
}

// --- ^C interrompt l'avant-plan -----------------------------------------------------
{
  const m = boot();
  writeJs(m, "loop.js", "#!/bin/js\nwhile (true) {}");
  m.tty.pushInput("./loop.js\n");
  for (let i = 0; i < 300; i++) m.kernel.tick(); // la boucle tourne
  m.tty.pushInput("^C\n");
  settle(m, "retour au prompt après ^C");
  A.eq("^C interrompt => $? = 130", sh(m, "echo $?"), "130");
  A.eq("le shell survit à ^C", sh(m, "echo encore la"), "encore la");
}
{
  const m = boot();
  const out = sh(m, "sleep 50 &");
  const pid = (out.match(/^\[1\] (\d+)/) || [])[1];
  m.tty.pushInput("^C\n");
  settle(m, "^C sans avant-plan");
  A.has("^C épargne les jobs en arrière-plan", sh(m, "ps"), "sleep");
  sh(m, `kill ${pid}`);
}

// --- REPL --------------------------------------------------------------------------
{
  const m = boot();
  A.has("node ouvre le REPL", sh(m, "node"), "REPL");
  A.has("évaluation directe", sh(m, "1 + 2 * 3"), "7");
  sh(m, "const x = 5");
  A.has("état persistant entre lignes", sh(m, "x * x"), "25");
  A.has("les chaînes sont citées", sh(m, '"a" + "b"'), '"ab"');
  A.has("erreur affichée sans tuer le REPL", sh(m, "yolo"), "yolo is not defined");
  A.has("le REPL survit", sh(m, "40 + 2"), "42");
  sh(m, ".exit");
  A.eq("retour au shell", sh(m, "echo shell"), "shell");
}

A.done();
