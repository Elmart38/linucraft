// Tests de la Phase 7 : apt — `apt list` (format apt, tri, périmètre registre),
// usage sans argument, sous-commandes non prises en charge, présence dans /bin.
import { boot, sh, makeAsserter } from "./lib.mjs";

const A = makeAsserter("linucraft — Phase 7 (apt)");

// --- apt list -------------------------------------------------------------------
{
  const m = boot();
  const out = sh(m, "apt list");
  A.has("en-tête apt", out, "En train de lister... Fait");
  A.has("sh listé", out, "sh/stable");
  A.has("node listé", out, "node/stable");
  A.has("nano listé", out, "nano/stable");
  A.has("cat listé", out, "cat/stable");
  A.has("apt se liste lui-même", out, "apt/stable");
  A.has("statut installé", out, "[installé]");
  A.has("version affichée", out, "/stable 2.2.6");

  const noms = out
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split("/")[0]);
  A.check("noms triés", JSON.stringify(noms) === JSON.stringify(noms.slice().sort()), noms.join(","));
  A.check("au moins 30 paquets", noms.length >= 30, `n=${noms.length}`);
  A.check("cd absent (built-in du shell)", !noms.includes("cd"), noms.join(","));
  A.check("sudo absent (built-in du shell)", !noms.includes("sudo"), noms.join(","));

  A.eq("apt list --installed = même sortie", sh(m, "apt list --installed"), out);
}

// --- Erreurs et codes de sortie ---------------------------------------------------
{
  const m = boot();
  A.has("apt seul → usage", sh(m, "apt"), "Utilisation : apt list");
  A.has("apt seul → code 1", sh(m, "apt || echo RC1"), "RC1");
  A.has("apt install → pas encore disponible", sh(m, "apt install truc"), "E: apt install n'est pas encore disponible");
  A.has("apt install → code 1", sh(m, "apt install truc || echo RC1"), "RC1");
  A.has("apt remove → pas encore disponible", sh(m, "apt remove truc"), "E: apt remove n'est pas encore disponible");
  A.has("sous-commande inconnue → E:", sh(m, "apt frobnique"), "E: Commande apt non prise en charge : frobnique");
  A.has("apt list → code 0", sh(m, "apt list > /dev/null && echo RC0"), "RC0");
}

// --- Intégration /bin --------------------------------------------------------------
{
  const m = boot();
  A.has("/bin contient apt", sh(m, "ls /bin"), "apt");
  A.has("help liste apt", sh(m, "help"), "apt");
}

A.done();
