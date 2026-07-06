// Tests de la Phase 4 : FS v2 (permissions, propriété, symlinks, chunking).
import { boot, sh, makeAsserter, makeStorage } from "./lib.mjs";
import { createVfs, splitPath } from "../linucraft_BP/scripts/os/vfs.js";

const A = makeAsserter("linucraft — Phase 4 (FS v2)");

// --- Métadonnées & ls -l ---------------------------------------------------
{
  const m = boot();
  sh(m, "touch f");
  A.has("ls -l montre le mode", sh(m, "ls -l f"), "-rw-r--r--");
  A.has("stat montre l'Uid", sh(m, "stat f"), "Uid: " + m.vfs.USER_UID);
  A.has("id de l'utilisateur", sh(m, "id"), `uid=${m.vfs.USER_UID}(elwin)`);
}

// --- chmod + permissions ---------------------------------------------------
{
  const m = boot();
  sh(m, "echo secret > s.txt");
  A.eq("lecture normale", sh(m, "cat s.txt"), "secret");
  sh(m, "chmod 000 s.txt");
  A.has("chmod 000 interdit la lecture", sh(m, "cat s.txt"), "Permission denied");
  sh(m, "chmod 644 s.txt");
  A.eq("chmod 644 rétablit la lecture", sh(m, "cat s.txt"), "secret");
  A.has("chmod +x visible en ls -l", (sh(m, "chmod +x s.txt"), sh(m, "ls -l s.txt")), "rwxr-xr-x");
}

// --- Permissions système (l'utilisateur n'est pas root) --------------------
{
  const m = boot();
  A.has("écriture dans /etc refusée", sh(m, "echo x > /etc/hack"), "Permission denied");
  A.has("mkdir dans / refusé", sh(m, "mkdir /oops"), "Permission denied");
}

// --- sudo ------------------------------------------------------------------
{
  const m = boot();
  sh(m, "sudo touch /etc/admin");
  A.has("sudo crée un fichier root dans /etc", sh(m, "stat /etc/admin"), "Uid: 0");
  A.has("sudo sh -c redirection root", (sh(m, "sudo sh -c 'echo hi > /etc/greet'"), sh(m, "cat /etc/greet")), "hi");
}

// --- su : shell imbriqué, exit revient au shell de base --------------------
{
  const m = boot();
  A.has("su root change d'identité", (sh(m, "su root"), sh(m, "id")), "uid=0(root)");
  A.eq("whoami après su", sh(m, "whoami"), "root");
  A.eq("root écrit dans /etc", (sh(m, "echo ok > /etc/rootfile"), sh(m, "cat /etc/rootfile")), "ok");
  A.eq("exit du su revient à l'utilisateur de base", (sh(m, "exit"), sh(m, "whoami")), "elwin");
}
{
  // `su -` : login shell root, sans créer d'utilisateur nommé "-".
  const m = boot();
  A.has("su - donne bien root", (sh(m, "su -"), sh(m, "id")), "uid=0(root)");
  A.eq("su - est un login shell dans /root", sh(m, "pwd"), "/root");
  A.eq("exit revient à l'utilisateur", (sh(m, "exit"), sh(m, "whoami")), "elwin");
  A.has("su vers un utilisateur inconnu échoue", sh(m, "su fantome"), "n'existe pas");
}

// --- uid distinct par utilisateur (plus tous à 1000) -----------------------
{
  const a = boot({ userId: "alice-id" });
  const b = boot({ userId: "bob-id" });
  A.check("uids distincts selon le joueur",
    a.vfs.USER_UID !== b.vfs.USER_UID && a.vfs.USER_UID > 0 && b.vfs.USER_UID > 0,
    `alice=${a.vfs.USER_UID} bob=${b.vfs.USER_UID}`);
  A.check("uid stable pour un même joueur",
    boot({ userId: "alice-id" }).vfs.USER_UID === a.vfs.USER_UID, "instable");
}

// --- Symlinks --------------------------------------------------------------
{
  const m = boot();
  sh(m, "echo cible > real.txt");
  sh(m, "ln -s real.txt lien");
  A.eq("cat suit le symlink", sh(m, "cat lien"), "cible");
  A.has("ls -l montre la flèche", sh(m, "ls -l lien"), "lien -> real.txt");
  A.has("symlink vers dossier", (sh(m, "ln -s /etc e"), sh(m, "cat e/motd")), "Bienvenue");
}

// --- df / du ---------------------------------------------------------------
{
  const m = boot();
  A.has("df affiche l'occupation", sh(m, "df"), "linucraft-fs");
  sh(m, "echo douze-chars > d.txt");
  const out = sh(m, "du d.txt");
  A.check("du renvoie une taille", /^\d+\s+d\.txt/.test(out), `got=${JSON.stringify(out)}`);
}

// --- Chunking : la limite des 32 Ko est démolie ----------------------------
{
  const storage = makeStorage();
  const bin = ["sh"];
  const v1 = createVfs({ storage, user: "elwin", userId: "p1", binNames: bin });
  const big = "ABCD".repeat(30000); // 120 000 caractères >> 32 Ko
  v1.writeFile(splitPath("/home/elwin/big.txt"), big);
  v1.save();
  const v2 = createVfs({ storage, user: "elwin", userId: "p1", binNames: bin });
  const r = v2.readFile(splitPath("/home/elwin/big.txt"));
  A.check("fichier 120 Ko persiste (chunking)", !r.err && r.data.length === 120000, `len=${r.data ? r.data.length : r.err}`);
}

// --- Persistance des permissions -------------------------------------------
{
  const storage = makeStorage();
  const m1 = boot({ storage });
  sh(m1, "touch keep.txt");
  sh(m1, "chmod 600 keep.txt");
  m1.vfs.save();
  const m2 = boot({ storage });
  A.has("le mode persiste", sh(m2, "ls -l keep.txt"), "-rw-------");
}

A.done();
