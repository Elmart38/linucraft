import { system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { createMachine } from "./os/machine.js";

// ---------------------------------------------------------------------------
// Couche plateforme : relie l'UI Minecraft (ModalForm) au TTY du noyau.
//
// - Un `system.runInterval` global bat le noyau de chaque machine active.
// - Le TTY appelle `wantInput()` quand le shell bloque sur une lecture : on
//   (ré)ouvre alors le formulaire pour demander une ligne au joueur.
// - La saisie est poussée dans le TTY (`pushInput`) ; le noyau l'exécute aux
//   ticks suivants, écrit la sortie dans le TTY, puis re-bloque → on rouvre.
// ---------------------------------------------------------------------------

const LOGO = "textures/ui/linucraft_logo.png";
const VISIBLE_LINES = 80;
const MIN_LINES = 22;

// --- Ordonnanceur global : un battement par tick pour chaque machine -------
const machines = new Set();
let intervalStarted = false;

function ensureInterval() {
  if (intervalStarted) return;
  intervalStarted = true;
  system.runInterval(() => {
    for (const m of machines) {
      try {
        m.kernel.tick();
      } catch (e) {
        /* un crash noyau ne doit pas tuer les autres machines */
      }
    }
  }, 1);
}

// --- Stockage : dynamic properties du monde --------------------------------
const storage = {
  get: (k) => world.getDynamicProperty(k),
  set: (k, v) => world.setDynamicProperty(k, v),
};

// Une session de terminal par joueur (réutilisée s'il rouvre le terminal).
const sessions = new Map();

function renderScrollback(tty) {
  const lines = tty.render().slice(-VISIBLE_LINES);
  while (lines.length < MIN_LINES) lines.unshift("");
  return lines.join("\n");
}

/** Point d'entrée : écran de boot puis terminal. */
export function openLincraft(player) {
  let session = sessions.get(player.id);
  if (!session) {
    const machine = createMachine({ storage, user: player.name, userId: player.id });
    session = { player, machine, formOpen: false, pendingOpen: false };
    sessions.set(player.id, session);
    machines.add(machine);
    ensureInterval();
    // Quand le shell attend une saisie, on (ré)ouvre le formulaire.
    machine.tty.wantInput = () => scheduleOpen(session);
  } else {
    session.player = player;
  }

  const boot = new ActionFormData()
    .title("linucraft 2.0")
    .body("§7Noyau prêt.§r\nAppuie pour ouvrir le terminal.")
    .button("Entrer dans le terminal", LOGO);

  boot
    .show(player)
    .then((res) => {
      if (res.canceled) return;
      scheduleOpen(session);
    })
    .catch((e) => player.sendMessage(`§clinucraft: ${e}`));
}

function scheduleOpen(session) {
  if (session.formOpen || session.pendingOpen) return;
  session.pendingOpen = true;
  system.run(() => {
    session.pendingOpen = false;
    openTerminal(session);
  });
}

function openTerminal(session) {
  if (session.formOpen) return;
  const { player, machine } = session;
  let form;
  try {
    form = new ModalFormData()
      .title("linucraft — terminal")
      .textField(renderScrollback(machine.tty), "tape une commande… (ex: ls, help, exit)");
  } catch (e) {
    player.sendMessage(`§clinucraft: impossible d'ouvrir le terminal: ${e}`);
    return;
  }
  session.formOpen = true;

  form
    .show(player)
    .then((res) => {
      session.formOpen = false;
      if (res.canceled) {
        if (res.cancelationReason === "UserBusy") {
          system.runTimeout(() => openTerminal(session), 10);
        } else {
          // Le joueur ferme le terminal : on persiste et on arrête la machine.
          machine.vfs.save();
          machines.delete(machine);
          sessions.delete(player.id);
        }
        return;
      }
      const [line] = res.formValues;
      machine.tty.pushInput((line ?? "") + "\n"); // réveille le shell
      machine.vfs.save();
      // Le noyau traite la ligne ; quand le shell re-bloque sur read,
      // wantInput() rappellera scheduleOpen() pour rouvrir le formulaire.
    })
    .catch((e) => {
      session.formOpen = false;
      player.sendMessage(`§clinucraft: erreur terminal: ${e}`);
    });
}
