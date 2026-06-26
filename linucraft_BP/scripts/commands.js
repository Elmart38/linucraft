import { joinPath } from "./fs.js";

// ---------------------------------------------------------------------------
// Commandes de linucraft v1.
// Chaque commande : (session, args, fs) => string (texte de sortie).
// Elle peut muter le FS (fs.*) et la session (session.cwd, session.scrollback).
// ---------------------------------------------------------------------------

const VERSION = "linucraft 1.0";

// Formate une erreur façon shell, en tolérant les messages courts ("File
// exists") comme longs ("cannot create directory: ...").
function fmtErr(cmd, arg, err) {
  if (err.startsWith("cannot") || err.startsWith("remove"))
    return `${cmd}: ${err}`;
  return `${cmd}: ${arg}: ${err}`;
}

// Sépare les drapeaux (-a, -r, ...) des opérandes.
function parseFlags(args) {
  const flags = new Set();
  const ops = [];
  for (const a of args) {
    if (a.length > 1 && a.startsWith("-")) {
      for (const ch of a.slice(1)) flags.add(ch);
    } else ops.push(a);
  }
  return { flags, ops };
}

export const commands = {
  help(session) {
    const names = Object.keys(commands).sort();
    return (
      "Commandes disponibles :\n  " +
      names.join("  ") +
      "\n\nExemples : ls -a   cd /etc   cat motd   echo salut > note.txt   neofetch\nTape §aexit§r pour quitter le terminal."
    );
  },

  exit(session) {
    session.quit = true;
    return "Au revoir !";
  },

  quit(session) {
    session.quit = true;
    return "Au revoir !";
  },

  pwd(session) {
    return joinPath(session.cwd);
  },

  whoami(session) {
    return session.user;
  },

  uname(session, args) {
    const { flags } = parseFlags(args);
    if (flags.has("a")) return "linucraft localhost 1.0 Minecraft Bedrock JS x86_64 linucraft";
    return "linucraft";
  },

  date() {
    return new Date().toString();
  },

  echo(session, args) {
    return args.join(" ");
  },

  history(session) {
    return session.history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join("\n");
  },

  clear(session) {
    session.scrollback = [];
    return "";
  },

  ls(session, args, fs) {
    const { flags, ops } = parseFlags(args);
    const target = ops[0] ?? ".";
    const segs = fs.resolve(session.cwd, target);
    const node = fs.getNode(segs);
    if (!node) return `ls: cannot access '${target}': No such file or directory`;
    if (node.t === "f") return segs[segs.length - 1] ?? target;
    let names = Object.keys(node.c);
    if (!flags.has("a")) names = names.filter((n) => !n.startsWith("."));
    names.sort();
    const labeled = names.map((n) => (node.c[n].t === "d" ? n + "/" : n));
    return labeled.join("  ");
  },

  cd(session, args, fs) {
    const target = args[0] ?? "~";
    const segs = fs.resolve(session.cwd, target);
    const node = fs.getNode(segs);
    if (!node) return `cd: ${target}: No such file or directory`;
    if (node.t !== "d") return `cd: ${target}: Not a directory`;
    session.cwd = segs;
    return "";
  },

  cat(session, args, fs) {
    if (args.length === 0) return "cat: usage: cat <fichier>";
    const out = [];
    for (const arg of args) {
      const node = fs.getNode(fs.resolve(session.cwd, arg));
      if (!node) out.push(`cat: ${arg}: No such file or directory`);
      else if (node.t === "d") out.push(`cat: ${arg}: Is a directory`);
      else out.push(node.d.replace(/\n$/, ""));
    }
    return out.join("\n");
  },

  mkdir(session, args, fs) {
    if (args.length === 0) return "mkdir: usage: mkdir <dossier>";
    const errs = [];
    for (const arg of args) {
      const r = fs.createDir(fs.resolve(session.cwd, arg));
      if (r.err) errs.push(fmtErr("mkdir", arg, r.err));
    }
    return errs.join("\n");
  },

  touch(session, args, fs) {
    if (args.length === 0) return "touch: usage: touch <fichier>";
    const errs = [];
    for (const arg of args) {
      const r = fs.touch(fs.resolve(session.cwd, arg));
      if (r.err) errs.push(fmtErr("touch", arg, r.err));
    }
    return errs.join("\n");
  },

  rm(session, args, fs) {
    const { flags, ops } = parseFlags(args);
    if (ops.length === 0) return "rm: usage: rm [-r] <chemin>";
    const recursive = flags.has("r") || flags.has("f");
    const errs = [];
    for (const arg of ops) {
      const r = fs.remove(fs.resolve(session.cwd, arg), recursive);
      if (r.err) errs.push(fmtErr("rm", arg, r.err));
    }
    return errs.join("\n");
  },

  neofetch(session, args, fs) {
    const info = [
      `${session.user}@linucraft`,
      "-----------------",
      `OS: ${VERSION} (Bedrock)`,
      "Kernel: minecraft-js",
      "Shell: lsh 1.0",
      "Terminal: ModalForm",
      "CPU: Redstone Core",
    ];
    const logo = [
      "   .--.   ",
      "  |o_o |  ",
      "  |:_/ |  ",
      " //   \\ \\ ",
      "(|     | )",
      "/'\\_   _/`\\",
      "\\___)=(___/",
    ];
    const lines = [];
    const n = Math.max(logo.length, info.length);
    for (let i = 0; i < n; i++) {
      const l = (logo[i] ?? "").padEnd(12);
      const r = info[i] ?? "";
      lines.push(l + r);
    }
    return lines.join("\n");
  },
};

// Noms exposés (sert au seed de /bin et au message d'aide).
export const commandNames = Object.keys(commands);
