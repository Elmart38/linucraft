import { joinPath } from "./fs.js";
import { commands } from "./commands.js";

// ---------------------------------------------------------------------------
// Le shell : crée la session, formate le prompt, parse et exécute une ligne.
// ---------------------------------------------------------------------------

const MAX_SCROLLBACK = 200; // lignes mémorisées (on affiche les ~80 dernières)

export function createSession(player, fs) {
  const session = {
    player,
    user: player.name,
    cwd: fs.homeSegments.slice(),
    history: [],
    scrollback: [],
    quit: false,
  };
  // MOTD au démarrage.
  const motd = fs.getNode(["etc", "motd"]);
  if (motd && motd.t === "f") session.scrollback.push(motd.d.replace(/\n$/, ""));
  return session;
}

// Chemin du cwd avec ~ pour le home (utilisé dans le prompt).
export function displayCwd(session, fs) {
  const home = fs.homeSegments;
  const cwd = session.cwd;
  const underHome =
    cwd.length >= home.length && home.every((seg, i) => cwd[i] === seg);
  if (underHome) {
    const rest = cwd.slice(home.length);
    return rest.length ? "~/" + rest.join("/") : "~";
  }
  return joinPath(cwd);
}

export function prompt(session, fs) {
  return `§a${session.user}@linucraft§r:§9${displayCwd(session, fs)}§r$ `;
}

// Tokenise une ligne (gestion minimale des guillemets " et ').
function tokenize(line) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

// Extrait une éventuelle redirection > / >> en fin de commande.
// Retourne { tokens, redirect: { append, target } | null }.
function extractRedirect(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === ">" || tokens[i] === ">>") {
      const append = tokens[i] === ">>";
      const target = tokens[i + 1];
      return { tokens: tokens.slice(0, i), redirect: { append, target } };
    }
  }
  return { tokens, redirect: null };
}

function pushLines(session, text) {
  if (text === "") return;
  for (const line of text.split("\n")) session.scrollback.push(line);
}

/** Exécute une ligne de commande dans la session. */
export function runLine(session, line, fs) {
  // Écho du prompt + de la commande tapée.
  session.scrollback.push(prompt(session, fs) + line);

  const trimmed = line.trim();
  if (trimmed !== "") {
    session.history.push(trimmed);

    const { tokens, redirect } = extractRedirect(tokenize(trimmed));
    const cmd = tokens[0];
    const args = tokens.slice(1);
    const fn = cmd ? commands[cmd] : null;

    let output;
    if (!fn) output = `§clsh: ${cmd}: command not found§r`;
    else {
      try {
        output = fn(session, args, fs) ?? "";
      } catch (e) {
        output = `§clsh: ${cmd}: ${e}§r`;
      }
    }

    if (redirect) {
      if (!redirect.target) {
        pushLines(session, "lsh: syntax error near `>'");
      } else {
        const r = fs.writeFile(
          fs.resolve(session.cwd, redirect.target),
          output === "" ? "" : output + "\n",
          redirect.append
        );
        if (r.err) pushLines(session, `lsh: ${redirect.target}: ${r.err}`);
      }
    } else {
      pushLines(session, output);
    }
  }

  // Sauvegarde si le FS a changé.
  const save = fs.save();
  if (save && save.err) pushLines(session, `lsh: ${save.err}`);

  // Borne la taille du scrollback.
  if (session.scrollback.length > MAX_SCROLLBACK)
    session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK);
}
