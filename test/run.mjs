// ---------------------------------------------------------------------------
// Harnais de test hors-jeu de linucraft.
//
// Le cœur de l'OS (noyau, VFS, stdlib, programmes) est du JS pur : on l'exécute
// ici dans Node en injectant un `storage` à base de Map et en pilotant le
// noyau tick par tick — exactement comme le ferait Minecraft, mais 1000× plus
// vite et de façon scriptable.   Lancer :  node test/run.mjs
// ---------------------------------------------------------------------------

import { createMachine } from "../linucraft_BP/scripts/os/machine.js";

function makeStorage() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
}

const strip = (s) => s.replace(/§./g, "");

// Fait avancer le noyau jusqu'à ce que le shell redemande une saisie.
function settle(machine, label) {
  for (let i = 0; i < 50000; i++) {
    machine.kernel.tick();
    if (machine.tty._asked && machine.tty.inputBuf === "") return;
  }
  throw new Error(`timeout (settle) : ${label}`);
}

function boot() {
  const machine = createMachine({ storage: makeStorage(), user: "elwin", userId: "p1" });
  settle(machine, "boot");
  return machine;
}

// Exécute une commande et renvoie sa sortie (lignes ajoutées, sans l'écho de
// la commande tapée), nettoyée des codes couleur.
function sh(machine, line) {
  const before = machine.tty.lines.length;
  machine.tty.pushInput(line + "\n");
  settle(machine, line);
  const added = machine.tty.lines.slice(before).map(strip);
  return added.slice(1).join("\n"); // [0] = écho "prompt + commande"
}

// --- Mini-framework d'assertions -------------------------------------------
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? "  →  " + detail : ""}`);
  }
}
const eq = (name, got, want) => check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const has = (name, got, sub) => check(name, got.includes(sub), `got=${JSON.stringify(got)} ⊅ ${JSON.stringify(sub)}`);

// --- Scénarios --------------------------------------------------------------
console.log("linucraft — tests hors-jeu\n");

{
  const m = boot();
  has("boot affiche le MOTD", machine_screen(m), "Bienvenue sur linucraft");
  has("boot affiche un prompt", machine_screen(m), "$");
}

function machine_screen(m) {
  return strip(m.tty.render().join("\n"));
}

{
  const m = boot();
  eq("echo simple", sh(m, "echo hi"), "hi");
  eq("echo multi-mots", sh(m, "echo a b c"), "a b c");
}

{
  const m = boot();
  eq("pwd initial = home", sh(m, "pwd"), "/home/elwin");
  has("ls /bin contient sh", sh(m, "ls /bin"), "sh");
  has("ls /bin contient echo", sh(m, "ls /bin"), "echo");
}

{
  const m = boot();
  eq("mkdir + cd + pwd", (sh(m, "mkdir projet"), sh(m, "cd projet"), sh(m, "pwd")), "/home/elwin/projet");
  eq("cd .. remonte", (sh(m, "cd .."), sh(m, "pwd")), "/home/elwin");
}

{
  const m = boot();
  sh(m, "echo bonjour > note.txt");
  eq("redirection > puis cat", sh(m, "cat note.txt"), "bonjour");
  sh(m, "echo suite >> note.txt");
  eq("redirection >> (append)", sh(m, "cat note.txt"), "bonjour\nsuite");
}

{
  const m = boot();
  eq("pipe wc -w", sh(m, "echo un deux trois | wc -w"), "3");
  eq("pipe echo|cat", sh(m, "echo coucou | cat"), "coucou");
  eq("grep via pipe", sh(m, "echo pomme | grep om"), "pomme");
  const n = sh(m, "ls /bin | grep c | wc -l");
  check("pipeline 3 étages (ls|grep|wc)", Number(n) > 0, `got=${n}`);
}

{
  const m = boot();
  eq("variable $USER", sh(m, "echo $USER"), "elwin");
  sh(m, "export FOO=42");
  eq("export puis $FOO", sh(m, "echo $FOO"), "42");
  eq("séquence ; et $?", sh(m, "true ; echo $?"), "0");
  eq("false met $? à 1", (sh(m, "false"), sh(m, "echo $?")), "1");
}

{
  const m = boot();
  has("ps liste le shell", sh(m, "ps"), "/bin/sh");
  const up = sh(m, "cat /proc/uptime");
  check("/proc/uptime est numérique", /^\d+$/.test(up.trim()), `got=${JSON.stringify(up)}`);
}

{
  const m = boot();
  has("commande inconnue", sh(m, "foobar"), "command not found");
}

{
  const m = boot();
  sh(m, "echo x");
  sh(m, "clear");
  const scr = machine_screen(m);
  check("clear efface l'écran", !scr.includes("echo x"), `screen=${JSON.stringify(scr)}`);
}

{
  const m = boot();
  has("neofetch", sh(m, "neofetch"), "linucraft");
  has("uname -a", sh(m, "uname -a"), "Minecraft Bedrock");
}

{
  // Persistance : une 2ᵉ machine partageant le storage doit retrouver le fichier.
  const storage = makeStorage();
  const m1 = createMachine({ storage, user: "elwin", userId: "p1" });
  settle(m1, "boot m1");
  sh(m1, "echo persiste > data.txt");
  m1.vfs.save();
  const m2 = createMachine({ storage, user: "elwin", userId: "p1" });
  settle(m2, "boot m2");
  eq("persistance via storage", sh(m2, "cat data.txt"), "persiste");
}

{
  // Préemption : un programme qui boucle ne doit pas bloquer le noyau pour
  // toujours — le budget par tick s'applique. On vérifie qu'un `yes`-like
  // (ici une boucle de sleep) rend bien la main.
  const m = boot();
  eq("sleep rend la main", sh(m, "sleep 0 ; echo apres"), "apres");
}

console.log(`\n${passed} ok, ${failed} échec(s).`);
process.exit(failed ? 1 : 0);
