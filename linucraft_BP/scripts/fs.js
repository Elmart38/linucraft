import { world } from "@minecraft/server";

// ---------------------------------------------------------------------------
// Système de fichiers virtuel de linucraft.
//
// Modèle de noeud :
//   dossier : { t: "d", c: { nom: node, ... } }
//   fichier : { t: "f", d: "contenu texte" }
//
// Stockage (dynamic properties du monde), façon "mixte" :
//   linucraft:fs_root      -> racine partagée (sans le contenu des /home)
//   linucraft:home_<id>    -> /home/<joueur> propre à chaque joueur
// ---------------------------------------------------------------------------

const ROOT_KEY = "linucraft:fs_root";
const HOME_PREFIX = "linucraft:home_";
const MAX_PROP = 32000; // marge sous la limite Bedrock de 32767 caractères

function dir(children = {}) {
  return { t: "d", c: children };
}
function file(content = "") {
  return { t: "f", d: content };
}

// Racine partagée par défaut (premier démarrage du monde).
function seedRoot(binNames) {
  const bin = {};
  for (const name of binNames) bin[name] = file("#!/bin/linucraft\n");
  return dir({
    bin: dir(bin),
    etc: dir({
      motd: file("Bienvenue sur linucraft 1.0 — tape `help` pour commencer.\n"),
      "os-release": file(
        'NAME="linucraft"\nVERSION="1.0"\nID=linucraft\nPRETTY_NAME="linucraft 1.0"\n'
      ),
    }),
    usr: dir({ bin: dir({}) }),
    tmp: dir({}),
    home: dir({}),
  });
}

// /home/<joueur> par défaut.
function seedHome() {
  return dir({
    "readme.txt": file("Tape `help` pour voir les commandes disponibles.\n"),
  });
}

// Découpe un chemin résolu en segments. Racine = [].
export function splitPath(p) {
  return p.split("/").filter((s) => s.length > 0);
}

export function joinPath(segments) {
  return "/" + segments.join("/");
}

/**
 * Construit un FS lié à un joueur : charge la racine partagée + monte le home
 * du joueur sous /home/<nom>.
 */
export function createFs(player, binNames) {
  const user = player.name;
  const homeKey = HOME_PREFIX + player.id;

  const rootStr = world.getDynamicProperty(ROOT_KEY);
  let root = rootStr ? JSON.parse(rootStr) : seedRoot(binNames);
  if (!root.c.home || root.c.home.t !== "d") root.c.home = dir({});

  const homeStr = world.getDynamicProperty(homeKey);
  const homeNode = homeStr ? JSON.parse(homeStr) : seedHome();
  root.c.home.c[user] = homeNode;

  const homeSegments = ["home", user];

  const fs = {
    user,
    root,
    homeSegments,
    dirty: !rootStr || !homeStr, // si rien n'existait, on sauvegarde le seed

    /** Résout une entrée (absolue, relative, ~, ., ..) en segments. */
    resolve(cwd, input) {
      let base;
      if (input.startsWith("/")) base = [];
      else if (input === "~" || input.startsWith("~/")) {
        base = homeSegments.slice();
        input = input.slice(1); // retire le ~
      } else base = cwd.slice();

      const out = base;
      for (const seg of input.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") out.pop();
        else out.push(seg);
      }
      return out;
    },

    /** Retourne le noeud à ce chemin, ou null. */
    getNode(segments) {
      let node = root;
      for (const seg of segments) {
        if (node.t !== "d" || !node.c[seg]) return null;
        node = node.c[seg];
      }
      return node;
    },

    isDir(segments) {
      const n = fs.getNode(segments);
      return !!n && n.t === "d";
    },

    createDir(segments) {
      if (segments.length === 0) return { err: "cannot create directory: File exists" };
      const parent = fs.getNode(segments.slice(0, -1));
      const name = segments[segments.length - 1];
      if (!parent || parent.t !== "d")
        return { err: "cannot create directory: No such file or directory" };
      if (parent.c[name]) return { err: "cannot create directory: File exists" };
      parent.c[name] = dir({});
      fs.dirty = true;
      return {};
    },

    /** Crée/écrase (ou ajoute) un fichier. */
    writeFile(segments, content, append = false) {
      if (segments.length === 0) return { err: "Is a directory" };
      const parent = fs.getNode(segments.slice(0, -1));
      const name = segments[segments.length - 1];
      if (!parent || parent.t !== "d") return { err: "No such file or directory" };
      const existing = parent.c[name];
      if (existing && existing.t === "d") return { err: "Is a directory" };
      if (append && existing && existing.t === "f") existing.d += content;
      else parent.c[name] = file(content);
      fs.dirty = true;
      return {};
    },

    /** touch : crée le fichier s'il n'existe pas. */
    touch(segments) {
      const node = fs.getNode(segments);
      if (node) return {}; // existe déjà : rien à faire
      return fs.writeFile(segments, "");
    },

    remove(segments, recursive) {
      if (segments.length === 0) return { err: "cannot remove '/': Permission denied" };
      const parent = fs.getNode(segments.slice(0, -1));
      const name = segments[segments.length - 1];
      const node = parent && parent.t === "d" ? parent.c[name] : null;
      if (!node) return { err: "No such file or directory" };
      if (node.t === "d" && !recursive) return { err: "Is a directory" };
      delete parent.c[name];
      fs.dirty = true;
      return {};
    },

    /** Sépare home/partagé et persiste dans les dynamic properties. */
    save() {
      if (!fs.dirty) return {};
      const homeNode = root.c.home.c[user] || dir({});
      const homeStr = JSON.stringify(homeNode);
      const clone = JSON.parse(JSON.stringify(root));
      clone.c.home.c = {}; // les /home sont stockés à part
      const rootStr = JSON.stringify(clone);
      if (homeStr.length > MAX_PROP || rootStr.length > MAX_PROP)
        return { err: "No space left on device" };
      world.setDynamicProperty(homeKey, homeStr);
      world.setDynamicProperty(ROOT_KEY, rootStr);
      fs.dirty = false;
      return {};
    },
  };

  return fs;
}
