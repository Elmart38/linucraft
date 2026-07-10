import { E } from "../errno.js";

// ---------------------------------------------------------------------------
// nano — éditeur de texte via livre-plume éphémère.
//
// Le programme (pur, aucun import Minecraft) prépare le contenu en pages de
// livre puis fait `yield SYS.host("bookEdit", {path, pages})` : la couche
// plateforme conjure un livre-plume dans l'inventaire du joueur, le laisse
// l'éditer dans l'UI native, puis complète l'appel avec :
//   { saved: true, pages }  — Enregistrer : on écrit le fichier ;
//   { saved: false }        — Annuler : fichier inchangé (sortie 0) ;
//   { error: "…" }          — problème côté jeu (inventaire plein, livre perdu…).
//
// Convention texte↔pages : un saut de page équivaut à un saut de ligne
// (pages jointes par "\n") ; le fichier sauvé se termine par un "\n" unique
// s'il n'est pas vide.
//
// Limites du livre Bedrock : 50 pages, 256 caractères par page (API), mais
// surtout l'ÉDITEUR n'affiche que 14 lignes de 121 pixels par page — une page
// remplie au-delà par script masque la suite et refuse toute saisie. On
// empaquette donc selon une estimation PESSIMISTE du rendu (retour à la ligne
// par mots, police à chasse variable ≈ 17 caractères sûrs par ligne) : chaque
// page produite reste entièrement visible et éditable.
// ---------------------------------------------------------------------------

export const PAGE_MAX = 256; // limite API de caractères par page
export const PAGES_MAX = 50;
export const PAGE_LINES = 14; // lignes visibles par page dans l'éditeur
export const WRAP_CHARS = 17; // caractères garantis par ligne (121 px / glyphe max ~7 px)

// Estimation pessimiste du nombre de lignes visuelles qu'occupe une ligne de
// fichier dans l'éditeur (qui coupe aux espaces, et coupe dur les mots trop
// longs). Pessimiste = jamais moins que le rendu réel → pas de débordement.
export function visualLines(line) {
  if (line.length <= WRAP_CHARS) return 1;
  let rows = 1;
  let col = 0; // caractères déjà posés sur la rangée courante
  for (const word of line.split(" ")) {
    let w = word.length + (col > 0 ? 1 : 0); // +1 : l'espace séparateur
    if (col > 0 && col + w > WRAP_CHARS) {
      rows++;
      col = 0;
      w = word.length;
    }
    while (col + w > WRAP_CHARS) {
      // mot (ou reste de mot) plus long qu'une rangée : coupe dure
      w -= WRAP_CHARS - col;
      rows++;
      col = 0;
    }
    col += w;
  }
  return rows;
}

// Découpe un texte en pages : lignes entières empaquetées gloutonnement, sous
// le double budget « lignes visuelles » et « caractères API » de chaque page.
// → { pages: string[] } ou { error: "…" } (ligne trop longue / trop de pages).
export function textToPages(text) {
  let t = text ?? "";
  if (t.endsWith("\n")) t = t.slice(0, -1); // le \n final redevient implicite
  const lines = t.split("\n");
  const pages = [];
  let page = null; // null = aucune page entamée (distinct d'une page vide "")
  let rows = 0; // lignes visuelles occupées sur la page en cours
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const v = visualLines(line);
    if (v > PAGE_LINES || line.length > PAGE_MAX)
      return { error: `ligne ${i + 1} trop longue pour le livre (max ~${PAGE_LINES * WRAP_CHARS} caractères)` };
    if (page === null) {
      page = line;
      rows = v;
    } else if (rows + v <= PAGE_LINES && page.length + 1 + line.length <= PAGE_MAX) {
      page += "\n" + line;
      rows += v;
    } else {
      pages.push(page);
      page = line;
      rows = v;
    }
  }
  pages.push(page ?? "");
  if (pages.length > PAGES_MAX) return { error: `fichier trop grand pour nano (max ${PAGES_MAX} pages)` };
  return { pages };
}

// Recompose le texte depuis les pages du livre (pages vides/illisibles → "").
export function pagesToText(pages) {
  const text = (pages || []).map((p) => p ?? "").join("\n");
  return text.length ? text + "\n" : "";
}

export function* nano(ctx) {
  const args = ctx.argv.slice(1);
  if (args.length !== 1) {
    yield ctx.sys.write(2, "nano: usage: nano <fichier>\n");
    return 1;
  }
  const cwd = yield ctx.sys.getcwd();
  const abs = args[0].startsWith("/") ? ctx.path.normalize(args[0]) : ctx.path.join(cwd, args[0]);

  // Fichiers spéciaux : /dev/zero se lit à l'infini, /proc est généré…
  // rien d'éditable là-dedans.
  if (abs === "/dev" || abs.startsWith("/dev/") || abs === "/proc" || abs.startsWith("/proc/")) {
    yield ctx.sys.write(2, `nano: ${abs}: fichier spécial non éditable\n`);
    return 1;
  }

  // Toutes les vérifications AVANT de conjurer le livre : le joueur ne doit
  // pas éditer dix minutes pour découvrir un refus à la sauvegarde.
  const st = yield ctx.sys.stat(abs);
  if (st && st.type === "d") {
    yield ctx.sys.write(2, `nano: ${abs}: ${ctx.strerror(E.ISDIR)}\n`);
    return 1;
  }
  let text = "";
  if (st) {
    const w = yield ctx.sys.access(abs, "w");
    if (w < 0) {
      yield ctx.sys.write(2, `nano: ${abs}: ${ctx.strerror(w)}\n`);
      return 1;
    }
    const r = yield* ctx.fs.readFile(abs);
    if (r.err) {
      yield ctx.sys.write(2, `nano: ${abs}: ${ctx.strerror(r.err)}\n`);
      return 1;
    }
    text = r.data;
  } else {
    // Fichier neuf : mêmes exigences que open("w"), mais création seulement
    // à la sauvegarde (Annuler ne doit rien laisser derrière lui).
    const dir = ctx.path.dirname(abs);
    const dst = yield ctx.sys.stat(dir);
    if (!dst) {
      yield ctx.sys.write(2, `nano: ${dir}: ${ctx.strerror(E.NOENT)}\n`);
      return 1;
    }
    if (dst.type !== "d") {
      yield ctx.sys.write(2, `nano: ${dir}: ${ctx.strerror(E.NOTDIR)}\n`);
      return 1;
    }
    const w = yield ctx.sys.access(dir, "w");
    if (w < 0) {
      yield ctx.sys.write(2, `nano: ${abs}: ${ctx.strerror(E.ACCES)}\n`);
      return 1;
    }
  }

  const packed = textToPages(text);
  if (packed.error) {
    yield ctx.sys.write(2, `nano: ${abs}: ${packed.error}\n`);
    return 1;
  }

  const res = yield ctx.sys.host("bookEdit", { path: abs, pages: packed.pages });

  if (!res || typeof res !== "object") {
    yield ctx.sys.write(2, "nano: réponse hôte invalide\n");
    return 1;
  }
  if (res.error) {
    yield ctx.sys.write(2, `nano: ${res.error}\n`);
    return 1;
  }
  if (res.saved === false) {
    yield ctx.sys.write(1, `nano: annulé, ${abs} inchangé\n`);
    return 0;
  }
  if (!Array.isArray(res.pages)) {
    yield ctx.sys.write(2, "nano: réponse hôte invalide\n");
    return 1;
  }
  const newText = pagesToText(res.pages);
  const w = yield* ctx.fs.writeFile(abs, newText);
  if (w.err) {
    yield ctx.sys.write(2, `nano: ${abs}: ${ctx.strerror(w.err)}\n`);
    // Le livre a déjà été repris : on recrache le texte pour ne rien perdre.
    if (newText.length) yield ctx.sys.write(1, newText);
    return 1;
  }
  const n = newText.length ? newText.split("\n").length - 1 : 0;
  yield ctx.sys.write(1, `nano: ${n} ligne(s) écrite(s) dans ${abs}\n`);
  return 0;
}
