// ---------------------------------------------------------------------------
// apt : gestionnaire de paquets (minimal). Seul `apt list` existe pour
// l'instant : il montre les programmes du registre au format apt. Tout est
// « installé » en dur — pas encore d'état installé/disponible ni d'install.
// ---------------------------------------------------------------------------

// Version affichée pour chaque paquet (à tenir à jour avec la version de l'addon).
const VERSION = "2.2.6";

export function* apt(ctx) {
  const cmd = ctx.argv[1];
  if (!cmd) {
    yield ctx.sys.write(2, "Utilisation : apt list\n");
    return 1;
  }
  if (cmd === "list") {
    const names = yield ctx.sys.listPrograms();
    const list = Array.isArray(names) ? names.slice().sort() : [];
    let out = "En train de lister... Fait\n";
    for (const n of list) out += `${n}/stable ${VERSION} [installé]\n`;
    yield ctx.sys.write(1, out);
    return 0;
  }
  if (cmd === "install" || cmd === "remove") {
    yield ctx.sys.write(2, `E: apt ${cmd} n'est pas encore disponible\n`);
    return 1;
  }
  yield ctx.sys.write(2, `E: Commande apt non prise en charge : ${cmd}\n`);
  return 1;
}
