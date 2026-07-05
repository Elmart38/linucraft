import { system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { createMachine } from "./os/machine.js";

// ---------------------------------------------------------------------------
// Couche plateforme : relie l'UI Minecraft (ModalForm) au TTY du noyau.
//
// Cycle de vie d'une session :
//   `linucraft` → écran de boot → bouton → création de la machine (noyau + sh).
//   Le shell bloque sur read → tty.wantInput() → on ouvre le ModalForm.
//   Saisie → pushInput → le noyau traite aux ticks suivants → le shell relit
//   → wantInput() → on rouvre. Échap : l'écran se ferme mais la machine
//   continue en arrière-plan (retaper `linucraft` pour s'y rattacher).
//   `exit` : le shell meurt → la machine est éteinte par l'ordonnanceur.
//
// Important : la machine n'est créée qu'APRÈS l'appui sur le bouton de boot,
// sinon le terminal (déclenché par wantInput) et l'écran de boot se font la
// course pour l'affichage.
// ---------------------------------------------------------------------------

const LOGO = "textures/ui/linucraft_logo.png";
const VISIBLE_LINES = 80;
const MIN_LINES = 22;
const BOOT_RETRIES = 20; // ouvert depuis le chat, l'écran de chat met 1-2 ticks à se fermer

const storage = {
  get: (k) => world.getDynamicProperty(k),
  set: (k, v) => world.setDynamicProperty(k, v),
};

const sessions = new Map(); // player.id -> { player, machine, formOpen, pendingOpen }
let intervalStarted = false;

// Un battement de noyau par tick pour chaque machine ; persiste le FS dès
// qu'il est sale ; éteint les machines dont le shell est mort (exit).
function ensureInterval() {
  if (intervalStarted) return;
  intervalStarted = true;
  system.runInterval(() => {
    for (const [id, s] of sessions) {
      try {
        s.machine.kernel.tick();
        if (s.machine.vfs.dirty) {
          const r = s.machine.vfs.save();
          if (r.err) {
            // On abandonne cette sauvegarde (retentée à la prochaine mutation).
            s.machine.vfs.dirty = false;
            s.machine.tty.write(null, `§ckernel: save: ${r.err}§r\n`);
          }
        }
        if (!s.machine.kernel.alive()) sessions.delete(id);
      } catch (e) {
        // Un crash noyau ne doit pas se répéter à chaque tick.
        sessions.delete(id);
        try {
          s.player.sendMessage(`§clinucraft: panique noyau: ${e}`);
        } catch {}
      }
    }
  }, 1);
}

// Nettoyage quand un joueur quitte le monde.
world.afterEvents.playerLeave.subscribe(({ playerId }) => {
  const s = sessions.get(playerId);
  if (s) {
    s.machine.vfs.save();
    sessions.delete(playerId);
  }
});

function renderScrollback(tty) {
  const lines = tty.render().slice(-VISIBLE_LINES);
  while (lines.length < MIN_LINES) lines.unshift("");
  return lines.join("\n");
}

/** Point d'entrée : écran de boot, puis terminal. */
export function openLincraft(player) {
  showBoot(player, 0);
}

function showBoot(player, attempt) {
  const resume = sessions.has(player.id);
  const boot = new ActionFormData()
    .title("linucraft 2.0")
    .body(
      resume
        ? "§7Une session tourne en arrière-plan.§r\nAppuie pour t'y rattacher."
        : "§7Noyau prêt.§r\nAppuie pour démarrer la machine."
    )
    .button(resume ? "Reprendre la session" : "Entrer dans le terminal", LOGO);

  boot
    .show(player)
    .then((res) => {
      if (res.canceled) {
        // Ouvert depuis le chat : l'écran de chat est encore ouvert → UserBusy.
        if (res.cancelationReason === "UserBusy" && attempt < BOOT_RETRIES)
          system.runTimeout(() => showBoot(player, attempt + 1), 5);
        return;
      }
      system.run(() => enterTerminal(player));
    })
    .catch((e) => player.sendMessage(`§clinucraft: ${e}`));
}

function enterTerminal(player) {
  let session = sessions.get(player.id);
  if (session) {
    // Machine vivante : on se rattache simplement à l'écran.
    session.player = player;
    scheduleOpen(session);
    return;
  }
  const machine = createMachine({ storage, user: player.name, userId: player.id });
  session = { player, machine, formOpen: false, pendingOpen: false };
  sessions.set(player.id, session);
  // Quand le shell attend une saisie, on (r)ouvre le formulaire.
  machine.tty.wantInput = () => scheduleOpen(session);
  ensureInterval();
  // Le shell va bloquer sur sa première lecture → wantInput ouvrira le terminal.
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
  if (!sessions.has(session.player.id)) return; // machine éteinte entre-temps
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
        if (res.cancelationReason === "UserBusy")
          system.runTimeout(() => openTerminal(session), 10);
        // UserClosed (Échap) : la machine continue en arrière-plan ;
        // retaper `linucraft` pour se rattacher à la session.
        return;
      }
      const [line] = res.formValues;
      machine.tty.pushInput((line ?? "") + "\n"); // réveille le shell
      // Quand le shell relira (prompt suivant), wantInput rouvrira l'écran.
    })
    .catch((e) => {
      session.formOpen = false;
      player.sendMessage(`§clinucraft: erreur terminal: ${e}`);
    });
}
