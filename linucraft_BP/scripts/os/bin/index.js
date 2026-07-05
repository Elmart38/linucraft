// ---------------------------------------------------------------------------
// Registre des programmes système : nom -> générateur main(ctx).
// Le noyau résout /bin/<nom> via ce registre (basename). Les noms servent
// aussi à peupler /bin dans le VFS (pour `ls /bin`, `help`, etc.).
// ---------------------------------------------------------------------------

import { sh } from "./sh.js";
import * as cu from "./coreutils.js";
import * as fu from "./fsutils.js";

export const programs = {
  sh,
  chmod: fu.chmod,
  chown: fu.chown,
  stat: fu.stat,
  ln: fu.ln,
  df: fu.df,
  du: fu.du,
  id: fu.id,
  echo: cu.echo,
  cat: cu.cat,
  ls: cu.ls,
  pwd: cu.pwd,
  whoami: cu.whoami,
  uname: cu.uname,
  date: cu.date,
  env: cu.env,
  mkdir: cu.mkdir,
  touch: cu.touch,
  rm: cu.rm,
  cp: cu.cp,
  mv: cu.mv,
  grep: cu.grep,
  wc: cu.wc,
  head: cu.head,
  tail: cu.tail,
  sort: cu.sort,
  clear: cu.clear,
  sleep: cu.sleep,
  ps: cu.ps,
  help: cu.help,
  neofetch: cu.neofetch,
  true: cu.trueCmd,
  false: cu.falseCmd,
};

// Noms à exposer dans /bin (inclut les built-ins du shell pour la complétion/aide).
export const programNames = Object.keys(programs).concat(
  ["cd", "exit", "export", "unset", "history", "test", "source", "sudo", "su", "jobs", "wait"]
);
