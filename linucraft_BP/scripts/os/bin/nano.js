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
// s'il n'est pas vide. Limites du livre Bedrock : 50 pages de 256 caractères.
// ---------------------------------------------------------------------------

export const PAGE_MAX = 256;
export const PAGES_MAX = 50;

// Découpe un texte en pages : lignes entières empaquetées gloutonnement.
// → { pages: string[] } ou { error: "…" } (ligne trop longue / trop de pages).
export function textToPages(text) {
  let t = text ?? "";
  if (t.endsWith("\n")) t = t.slice(0, -1); // le \n final redevient implicite
  const lines = t.split("\n");
  const pages = [];
  let page = null; // null = aucune page entamée (distinct d'une page vide "")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > PAGE_MAX)
      return { error: `ligne ${i + 1} trop longue pour le livre (max ${PAGE_MAX} caractères)` };
    if (page === null) page = line;
    else if (page.length + 1 + line.length <= PAGE_MAX) page += "\n" + line;
    else {
      pages.push(page);
      page = line;
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
