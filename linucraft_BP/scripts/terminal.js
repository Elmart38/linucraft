import { system } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { createFs } from "./fs.js";
import { commandNames } from "./commands.js";
import { createSession, runLine } from "./shell.js";

// ---------------------------------------------------------------------------
// Interface : écran de boot (ActionForm + logo) puis boucle terminal
// (ModalForm : historique en label + champ de saisie).
// ---------------------------------------------------------------------------

const LOGO = "textures/ui/lincraft_logo.png";
const VISIBLE_LINES = 50;

function renderScrollback(session) {
  const lines = session.scrollback.slice(-VISIBLE_LINES);
  const text = lines.join("\n");
  return text.length ? text : " ";
}

/** Point d'entrée : ouvre l'écran de boot pour un joueur. */
export function openLincraft(player) {
  const fs = createFs(player, commandNames);
  const session = createSession(player, fs);

  const boot = new ActionFormData()
    .title("lincraft 1.0")
    .body("§7Système prêt.§r\nAppuie sur le bouton pour ouvrir le terminal.")
    .button("Entrer dans le terminal", LOGO);

  boot.show(player).then((res) => {
    if (res.canceled) return;
    system.run(() => openTerminal(session, fs));
  });
}

/** Boucle du terminal : affiche l'historique, lit une commande, recommence. */
function openTerminal(session, fs) {
  const form = new ModalFormData()
    .title("lincraft — terminal")
    .label(renderScrollback(session))
    .textField("", "tape une commande… (ex: ls, help, cat /etc/motd)")
    .toggle("Quitter le terminal", false);

  form.show(session.player).then((res) => {
    // Le joueur était occupé (chat/menu ouvert) : on réessaie au tick suivant.
    if (res.canceled) {
      if (res.cancelationReason === "UserBusy")
        system.runTimeout(() => openTerminal(session, fs), 10);
      else fs.save();
      return;
    }

    const [line, quit] = res.formValues;
    if (quit) {
      fs.save();
      return;
    }

    runLine(session, line ?? "", fs);
    system.run(() => openTerminal(session, fs));
  });
}
