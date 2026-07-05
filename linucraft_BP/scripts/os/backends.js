import { E } from "./errno.js";

// ---------------------------------------------------------------------------
// Backends de descripteurs de fichiers.
//
// Un « open file description » (OFD) = un objet d'état détenu par le noyau,
// portant un `backend` polymorphe. Le noyau appelle, de façon SYNCHRONE :
//   backend.read(ofd, n)  -> { data } | { eof:true } | { block:true } | { err }
//   backend.write(ofd, s) -> { n }    | { block:true } | { err }
//   backend.close(ofd)
// `block:true` signale au scheduler que l'opération bloquerait : le processus
// passe en BLOCKED et le syscall est ré-essayé plus tard. C'est de l'I/O non
// bloquant côté noyau, d'apparence bloquante côté programme (modèle Unix).
// ---------------------------------------------------------------------------

// --- TTY : le terminal (pont avec l'UI ModalForm) --------------------------
export function createTTY() {
  const tty = {
    kind: "tty",
    lines: [], // lignes complètes du scrollback
    cur: "", // ligne en cours (sans \n final)
    inputBuf: "", // saisie en attente d'être lue
    wantInput: null, // callback : appelé quand un read bloque (UI doit demander une ligne)
    _asked: false,

    write(ofd, data) {
      for (const ch of data) {
        if (ch === "\n") {
          tty.lines.push(tty.cur);
          tty.cur = "";
        } else if (ch === "\f") {
          // form-feed : efface l'écran (c'est ainsi que `clear` opère).
          tty.lines = [];
          tty.cur = "";
        } else if (ch !== "\r") {
          tty.cur += ch;
        }
      }
      return { n: data.length };
    },

    read(ofd, n) {
      if (tty.inputBuf.length === 0) {
        // Rien à lire : on demande une saisie à l'UI (une seule fois).
        if (!tty._asked) {
          tty._asked = true;
          if (tty.wantInput) tty.wantInput();
        }
        return { block: true };
      }
      const data = tty.inputBuf.slice(0, n);
      tty.inputBuf = tty.inputBuf.slice(n);
      return { data };
    },

    close() {},

    // --- API plateforme ---
    pushInput(s) {
      tty.inputBuf += s;
      tty._asked = false;
    },
    clear() {
      tty.lines = [];
      tty.cur = "";
    },
    render() {
      return tty.cur.length ? tty.lines.concat(tty.cur) : tty.lines.slice();
    },
  };
  return tty;
}

// --- Fichier régulier (au-dessus du VFS) -----------------------------------
// L'OFD porte : segments, mode ('r'|'w'|'a'), buf (lecture), pos, wbuf (écriture).
export function createFileBackend(vfs) {
  return {
    kind: "file",
    read(ofd, n) {
      if (ofd.pos >= ofd.buf.length) return { eof: true };
      const data = ofd.buf.slice(ofd.pos, ofd.pos + n);
      ofd.pos += data.length;
      return { data };
    },
    write(ofd, data) {
      ofd.wbuf += data;
      return { n: data.length };
    },
    ref(ofd) {
      ofd.refs = (ofd.refs || 1) + 1;
    },
    close(ofd) {
      // Refcount : un fichier en écriture n'est écrit qu'à la dernière fermeture
      // (sinon une redirection partagée par spawn écraserait le contenu).
      ofd.refs = (ofd.refs || 1) - 1;
      if (ofd.refs > 0) return;
      if (ofd.mode === "w" || ofd.mode === "a") {
        vfs.writeFile(ofd.segments, ofd.wbuf, ofd.mode === "a", ofd.meta);
      }
    },
  };
}

// --- Tampon mémoire en lecture seule (pour /proc, substitution…) -----------
export const memReadBackend = {
  kind: "mem",
  read(ofd, n) {
    if (ofd.pos >= ofd.buf.length) return { eof: true };
    const data = ofd.buf.slice(ofd.pos, ofd.pos + n);
    ofd.pos += data.length;
    return { data };
  },
  write() {
    return { err: E.BADF };
  },
  close() {},
};

// --- Périphériques /dev ------------------------------------------------------
export const nullBackend = {
  kind: "null",
  read() {
    return { eof: true };
  },
  write(ofd, data) {
    return { n: data.length };
  },
  close() {},
};

export const zeroBackend = {
  kind: "zero",
  read(ofd, n) {
    return { data: "\0".repeat(Math.min(n, 4096)) };
  },
  write(ofd, data) {
    return { n: data.length };
  },
  close() {},
};

export const randomBackend = {
  kind: "random",
  read(ofd, n) {
    const k = Math.min(n, 4096);
    let s = "";
    const hex = "0123456789abcdef";
    for (let i = 0; i < k; i++) s += hex[(Math.random() * 16) | 0];
    return { data: s };
  },
  write() {
    return { err: E.BADF };
  },
  close() {},
};

// --- Tube (pipe) : deux extrémités partageant un tampon --------------------
export function createPipe() {
  // writers/readers = nombre de fd ouverts pointant sur chaque extrémité.
  // `ref` est appelé par le noyau quand un fd est dupliqué (spawn/dup2).
  const state = { buf: "", writers: 1, readers: 1 };
  const readEnd = {
    kind: "pipe-r",
    read(ofd, n) {
      if (state.buf.length > 0) {
        const data = state.buf.slice(0, n);
        state.buf = state.buf.slice(n);
        return { data };
      }
      if (state.writers <= 0) return { eof: true };
      return { block: true };
    },
    write() {
      return { err: E.BADF };
    },
    ref() {
      state.readers++;
    },
    close() {
      state.readers--;
    },
  };
  const writeEnd = {
    kind: "pipe-w",
    read() {
      return { err: E.BADF };
    },
    write(ofd, data) {
      if (state.readers <= 0) return { err: E.PIPE };
      state.buf += data;
      return { n: data.length };
    },
    ref() {
      state.writers++;
    },
    close() {
      state.writers--;
    },
  };
  return { readEnd, writeEnd };
}
