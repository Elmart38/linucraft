// ---------------------------------------------------------------------------
// Codes d'erreur façon POSIX (valeurs négatives renvoyées par les syscalls).
// Un syscall renvoie un entier >= 0 en cas de succès (fd, nb d'octets, pid…)
// ou un de ces codes (< 0) en cas d'erreur.
// ---------------------------------------------------------------------------

export const E = {
  PERM: -1, // EPERM   opération non permise
  NOENT: -2, // ENOENT  fichier ou dossier introuvable
  SRCH: -3, // ESRCH   processus introuvable
  BADF: -9, // EBADF   mauvais descripteur de fichier
  NOMEM: -12, // ENOMEM  plus de mémoire
  ACCES: -13, // EACCES  permission refusée
  EXIST: -17, // EEXIST  existe déjà
  NOTDIR: -20, // ENOTDIR n'est pas un dossier
  ISDIR: -21, // EISDIR  est un dossier
  INVAL: -22, // EINVAL  argument invalide
  NOSPC: -28, // ENOSPC  plus d'espace
  PIPE: -32, // EPIPE   tube cassé
};

// Message lisible associé à un code (pour les programmes).
const MSG = {
  [E.PERM]: "Operation not permitted",
  [E.NOENT]: "No such file or directory",
  [E.SRCH]: "No such process",
  [E.BADF]: "Bad file descriptor",
  [E.NOMEM]: "Cannot allocate memory",
  [E.ACCES]: "Permission denied",
  [E.EXIST]: "File exists",
  [E.NOTDIR]: "Not a directory",
  [E.ISDIR]: "Is a directory",
  [E.INVAL]: "Invalid argument",
  [E.NOSPC]: "No space left on device",
  [E.PIPE]: "Broken pipe",
};

export function strerror(code) {
  return MSG[code] || `error ${code}`;
}

// Traduit un message d'erreur du VFS (texte) en code errno.
export function errnoFromVfs(msg) {
  if (!msg) return E.INVAL;
  if (/No such file/.test(msg)) return E.NOENT;
  if (/Is a directory/.test(msg)) return E.ISDIR;
  if (/Not a directory/.test(msg)) return E.NOTDIR;
  if (/File exists/.test(msg)) return E.EXIST;
  if (/No space/.test(msg)) return E.NOSPC;
  if (/Permission denied/.test(msg)) return E.PERM;
  return E.INVAL;
}
