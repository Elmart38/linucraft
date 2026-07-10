// Tests de la Phase 6 : nano (livre-plume éphémère) — découpage texte↔pages,
// canal hôte du noyau (blocage/complétion), permissions, annulation, limites.
import { boot, sh, makeAsserter, settle, screen } from "./lib.mjs";
import { splitPath } from "../linucraft_BP/scripts/os/vfs.js";
import { textToPages, pagesToText, visualLines, PAGES_MAX, PAGE_LINES } from "../linucraft_BP/scripts/os/bin/nano.js";

const A = makeAsserter("linucraft — Phase 6 (nano / canal hôte)");

// Complète chaque appel hôte avec le retour de `fn` (undefined = laisser pendant).
function autoHost(m, fn) {
  m.kernel.onHostCall = (req) => {
    const r = fn(req);
    if (r !== undefined) m.kernel.completeHostCall(req.id, r);
  };
}

// Tick jusqu'à ce qu'un appel hôte soit en attente (nano bloqué dessus).
function tickUntilHost(m, label) {
  for (let i = 0; i < 200000; i++) {
    const calls = m.kernel.hostCalls();
    if (calls.length) return calls[0];
    m.kernel.tick();
  }
  throw new Error(`timeout (host) : ${label}`);
}

// Sème un fichier directement dans le VFS (évite l'échappement shell).
function seedFile(m, p, src) {
  const u = m.vfs.USER_UID;
  m.vfs.writeFile(splitPath(p), src, false, { m: 0o644, u, g: u });
}
function readVfs(m, p) {
  const r = m.vfs.readFile(splitPath(p));
  return r.err ? null : r.data;
}

// --- Unités pures : textToPages / pagesToText --------------------------------
{
  A.eq("vide → une page vide", JSON.stringify(textToPages("").pages), '[""]');
  A.eq("page vide → texte vide", pagesToText([""]), "");
  A.eq("round-trip simple", pagesToText(textToPages("a\nb\n").pages), "a\nb\n");
  A.eq("round-trip lignes vides", pagesToText(textToPages("a\n\n\nb\n").pages), "a\n\n\nb\n");
  A.eq("normalisation sans \\n final", pagesToText(textToPages("a").pages), "a\n");
  // Limites VISUELLES de l'éditeur : 14 lignes/page, ~17 caractères/rangée.
  const lmax = "x".repeat(238); // 14 rangées de 17 caractères pile
  A.eq("ligne de 238 remplit une page seule", JSON.stringify(textToPages(lmax + "\ny\n").pages), JSON.stringify([lmax, "y"]));
  A.has("ligne de 239 → erreur", textToPages("x".repeat(239) + "\n").error, "trop longue");
  A.has("51 pages → erreur", textToPages((lmax + "\n").repeat(PAGES_MAX + 1)).error, "trop grand");
  A.eq("14 lignes courtes = une page", textToPages("a\n".repeat(PAGE_LINES)).pages.length, 1);
  A.eq("15 lignes courtes = deux pages", textToPages("a\n".repeat(PAGE_LINES + 1)).pages.length, 2);
  A.eq("césure par mots comptée (3 rangées)", visualLines("aaaaaaaaaa bbbbbbbbbb cccccccccc"), 3);
  A.eq("mot long coupé dur (200 car. = 12 rangées)", visualLines("A".repeat(200)), 12);
  A.eq("page undefined → ligne vide", pagesToText([undefined, "x"]), "\nx\n");
  const deux = "A".repeat(200) + "\n" + "B".repeat(200) + "\n";
  A.eq("multi-pages : 2 pages", textToPages(deux).pages.length, 2);
  A.eq("multi-pages round-trip", pagesToText(textToPages(deux).pages), deux);
}

// --- Édition nominale ---------------------------------------------------------
{
  const m = boot();
  sh(m, "echo l1 > f");
  sh(m, "echo l2 >> f");
  let seen = null;
  autoHost(m, (req) => {
    seen = req;
    return { saved: true, pages: ["A\nB"] };
  });
  const out = sh(m, "nano f && echo RC0");
  A.eq("kind bookEdit", seen && seen.kind, "bookEdit");
  A.eq("chemin absolu dans le payload", seen && seen.payload.path, "/home/elwin/f");
  A.eq("pages initiales du livre", JSON.stringify(seen && seen.payload.pages), JSON.stringify(["l1\nl2"]));
  A.has("compte de lignes écrit", out, "2 ligne(s) écrite(s) dans /home/elwin/f");
  A.has("succès → code 0", out, "RC0");
  A.eq("contenu réécrit", sh(m, "cat f"), "A\nB");
  A.eq("fichier terminé par \\n", readVfs(m, "/home/elwin/f"), "A\nB\n");
}

// --- Nouveau fichier ----------------------------------------------------------
{
  const m = boot();
  let pagesVues = null;
  autoHost(m, (req) => {
    pagesVues = req.payload.pages;
    return { saved: true, pages: ["premier"] };
  });
  sh(m, "nano neuf.txt");
  A.eq("nouveau fichier → livre vide", JSON.stringify(pagesVues), '[""]');
  A.eq("créé avec \\n final", readVfs(m, "/home/elwin/neuf.txt"), "premier\n");

  autoHost(m, () => ({ saved: false }));
  const out = sh(m, "nano fantome.txt && echo RC0");
  A.has("annulation → message", out, "annulé");
  A.has("annulation → code 0", out, "RC0");
  A.eq("rien créé après annulation", readVfs(m, "/home/elwin/fantome.txt"), null);
}

// --- Annulation et erreur hôte sur fichier existant ---------------------------
{
  const m = boot();
  sh(m, "echo garde > f");
  autoHost(m, () => ({ saved: false }));
  sh(m, "nano f");
  A.eq("annulation → fichier intact", sh(m, "cat f"), "garde");

  autoHost(m, () => ({ error: "inventaire plein — libère un emplacement et relance nano" }));
  const out = sh(m, "nano f || echo RC1");
  A.has("erreur hôte affichée", out, "inventaire plein");
  A.has("erreur hôte → code 1", out, "RC1");
  A.eq("erreur hôte → fichier intact", sh(m, "cat f"), "garde");
}

// --- Refus AVANT de conjurer le livre ------------------------------------------
{
  const m = boot();
  let called = 0;
  autoHost(m, () => {
    called++;
    return { saved: false };
  });
  A.has("usage sans argument", sh(m, "nano"), "usage");
  A.has("usage deux arguments", sh(m, "nano a b"), "usage");
  A.has("dossier → Is a directory", sh(m, "nano /etc"), "Is a directory");
  A.has("parent inexistant", sh(m, "nano /nulle/part.txt"), "No such file");
  A.has("fichier spécial /dev refusé", sh(m, "nano /dev/zero"), "non éditable");
  A.has("fichier spécial /proc refusé", sh(m, "nano /proc/uptime"), "non éditable");
  seedFile(m, "/home/elwin/long.txt", "x".repeat(300) + "\n");
  A.has("ligne trop longue refusée", sh(m, "nano long.txt"), "trop longue");
  seedFile(m, "/home/elwin/gros.txt", ("y".repeat(238) + "\n").repeat(60));
  A.has("fichier trop grand refusé", sh(m, "nano gros.txt"), "trop grand");
  A.eq("hôte jamais sollicité", called, 0);
}

// --- Régression : recharger un fichier multi-pages ne tasse pas tout en page 1 ---
{
  const m = boot();
  const p1 = Array.from({ length: 10 }, (_, i) => "ligne " + (i + 1)).join("\n");
  const p2 = Array.from({ length: 10 }, (_, i) => "suite " + (i + 1)).join("\n");
  autoHost(m, () => ({ saved: true, pages: [p1, p2] }));
  sh(m, "nano deux.txt"); // création : le joueur écrit 2 pages
  let recu = null;
  autoHost(m, (req) => {
    recu = req.payload.pages;
    return { saved: false };
  });
  sh(m, "nano deux.txt"); // rechargement du même fichier
  A.check("rechargé sur plusieurs pages", !!recu && recu.length >= 2, `pages=${recu && recu.length}`);
  A.check("chaque page tient dans l'éditeur (≤ 14 lignes visuelles)",
    !!recu && recu.every((p) => p.split("\n").reduce((n, l) => n + visualLines(l), 0) <= PAGE_LINES),
    JSON.stringify(recu));
}

// --- Permissions ----------------------------------------------------------------
{
  const m = boot();
  let calls = 0;
  autoHost(m, () => {
    calls++;
    return { saved: true, pages: ["root ici"] };
  });
  sh(m, "sudo touch /etc/verrou");
  A.has("fichier root refusé en écriture", sh(m, "nano /etc/verrou"), "Permission denied");
  A.has("création dans /etc refusée", sh(m, "nano /etc/nouveau.txt"), "Permission denied");
  A.eq("refus sans appel hôte", calls, 0);
  sh(m, "sudo nano /etc/verrou");
  A.eq("sudo nano écrit le fichier root", sh(m, "cat /etc/verrou"), "root ici");
  sh(m, "touch mien.txt && chmod 000 mien.txt");
  A.has("chmod 000 → refus", sh(m, "nano mien.txt"), "Permission denied");
}

// --- Plomberie : blocage, complétion, doubles complétions -------------------------
{
  const m = boot();
  sh(m, "echo a > f");
  m.tty.pushInput("nano f\n");
  const req = tickUntilHost(m, "nano bloqué");
  const p = m.kernel.snapshot().find((x) => x.cmd.includes("nano"));
  A.check("nano bloqué (état blocked)", !!p && p.state === "blocked", p && p.state);
  for (let i = 0; i < 50; i++) m.kernel.tick();
  A.eq("toujours en attente après 50 ticks", m.kernel.hostCalls().length, 1);
  A.eq("id inconnu → false", m.kernel.completeHostCall(99999, {}), false);
  A.eq("complétion → true", m.kernel.completeHostCall(req.id, { saved: false }), true);
  A.eq("double complétion → false", m.kernel.completeHostCall(req.id, { saved: false }), false);
  settle(m, "reprise après complétion");
  A.has("nano a repris (annulé)", screen(m), "annulé");
}

// --- Mort du processus pendant l'édition ------------------------------------------
{
  const m = boot();
  sh(m, "echo a > f");
  sh(m, "nano f &");
  const req = tickUntilHost(m, "nano & bloqué");
  sh(m, `kill ${req.pid}`);
  A.eq("appel purgé après kill", m.kernel.hostCalls().length, 0);
  A.eq("complétion après kill → false", m.kernel.completeHostCall(req.id, { saved: true, pages: [] }), false);
}

A.done();
