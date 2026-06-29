import { createVfs } from "./vfs.js";
import { createTTY } from "./backends.js";
import { createKernel } from "./kernel.js";
import { programs, programNames } from "./bin/index.js";

// ---------------------------------------------------------------------------
// Assemble une « machine » linucraft complète : VFS + TTY + noyau, avec le
// shell lancé comme processus init. Code pur (aucun import Minecraft) → on peut
// l'instancier en test hors-jeu en injectant un `storage` à base de Map.
// ---------------------------------------------------------------------------

export function createMachine({ storage, user, userId }) {
  const vfs = createVfs({ storage, user, userId, binNames: programNames });
  const tty = createTTY();
  const kernel = createKernel({ vfs, tty, programs });
  kernel.start("/bin/sh", []);
  return { vfs, tty, kernel };
}
