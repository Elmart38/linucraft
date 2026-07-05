// Helpers partagés pour les batteries de tests hors-jeu.
import { createMachine } from "../linucraft_BP/scripts/os/machine.js";

export function makeStorage() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
}

export const strip = (s) => s.replace(/§./g, "");

export function settle(machine, label) {
  for (let i = 0; i < 200000; i++) {
    machine.kernel.tick();
    if (machine.tty._asked && machine.tty.inputBuf === "") return;
  }
  throw new Error(`timeout (settle) : ${label}`);
}

export function boot(opts = {}) {
  const machine = createMachine({ storage: opts.storage || makeStorage(), user: opts.user || "elwin", userId: opts.userId || "p1" });
  settle(machine, "boot");
  return machine;
}

// Exécute une commande, renvoie sa sortie (sans l'écho de la commande tapée).
export function sh(machine, line) {
  const before = machine.tty.lines.length;
  machine.tty.pushInput(line + "\n");
  settle(machine, line);
  return machine.tty.lines.slice(before).map(strip).slice(1).join("\n");
}

export function screen(machine) {
  return strip(machine.tty.render().join("\n"));
}

export function makeAsserter(title) {
  let passed = 0, failed = 0;
  console.log(`${title}\n`);
  const check = (name, cond, detail) => {
    if (cond) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? "  →  " + detail : ""}`); }
  };
  return {
    check,
    eq: (name, got, want) => check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`),
    has: (name, got, sub) => check(name, got.includes(sub), `got=${JSON.stringify(got)} ⊅ ${JSON.stringify(sub)}`),
    done: () => { console.log(`\n${passed} ok, ${failed} échec(s).`); process.exit(failed ? 1 : 0); },
  };
}
