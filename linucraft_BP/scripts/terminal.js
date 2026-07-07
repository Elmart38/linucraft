import { system, world, ItemStack, ItemLockMode } from "@minecraft/server";
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
const NANO_MARK = "§lnano§r — "; // préfixe du nameTag des livres conjurés par nano

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
  // Requêtes des programmes vers la couche Minecraft (nano → livre-plume).
  machine.kernel.onHostCall = (req) => handleHostCall(session, req);
  // Machine neuve : aucun livre nano ne peut être légitime, on balaye les
  // orphelins d'une session précédente (déconnexion pendant une édition).
  sweepNanoBooks(player);
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
  // Une édition nano en cours a priorité : on ré-affiche son formulaire
  // (Enregistrer/Annuler) au lieu de l'écran de saisie du terminal.
  const hostReq = machine.kernel.hostCalls().find((r) => r.kind === "bookEdit");
  if (hostReq) {
    showNanoForm(session, hostReq);
    return;
  }
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

// ---------------------------------------------------------------------------
// nano — réalisation de l'appel hôte "bookEdit" (voir os/bin/nano.js).
//
// Le programme nano (pur) bloque sur `yield SYS.host("bookEdit", {path, pages})`.
// Ici on conjure un livre-plume ÉPHÉMÈRE dans l'inventaire du joueur (contenu
// = le fichier), on affiche un formulaire Enregistrer/Annuler, et on complète
// l'appel avec { saved:true, pages } / { saved:false } / { error }. Le livre
// est repris (retiré de l'inventaire) dans tous les cas : il n'existe que
// pendant l'édition. Échap laisse l'appel pendant : retaper `linucraft`
// ré-affiche le formulaire (branche dédiée dans openTerminal).
// ---------------------------------------------------------------------------

function handleHostCall(session, req) {
  if (req.kind !== "bookEdit") {
    session.machine.kernel.completeHostCall(req.id, { error: `appel hôte inconnu: ${req.kind}` });
    return;
  }
  // Hors du tick noyau (même précaution que scheduleOpen).
  system.run(() => startBookEdit(session, req));
}

function startBookEdit(session, req) {
  const { player, machine } = session;
  const fail = (msg) => machine.kernel.completeHostCall(req.id, { error: msg });
  try {
    if (!sessions.has(player.id)) return; // machine éteinte entre-temps
    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) {
      fail("inventaire inaccessible");
      return;
    }
    // Balaye les livres orphelins en épargnant ceux des éditions en cours.
    sweepNanoBooks(player, keepTagsFor(machine, req.id));
    if (container.emptySlotsCount === 0) {
      fail("inventaire plein — libère un emplacement et relance nano");
      return;
    }
    const book = new ItemStack("minecraft:writable_book", 1);
    book.getComponent("minecraft:book").setContents(req.payload.pages);
    book.nameTag = NANO_MARK + req.payload.path;
    book.keepOnDeath = true;
    book.lockMode = ItemLockMode.inventory; // ni jetable, ni déposable dans un coffre
    container.addItem(book);
    showNanoForm(session, req);
  } catch (e) {
    fail(`impossible de créer le livre: ${e}`);
  }
}

function showNanoForm(session, req) {
  if (session.formOpen) return;
  if (!sessions.has(session.player.id)) return;
  const { player, machine } = session;
  // L'appel a pu mourir entre-temps (kill pendant l'édition) : ménage et stop.
  if (!machine.kernel.hostCalls().some((r) => r.id === req.id)) {
    sweepNanoBooks(player, keepTagsFor(machine));
    return;
  }
  let form;
  try {
    form = new ActionFormData()
      .title(`nano — ${req.payload.path}`)
      .body(
        "§7Un livre-plume est apparu dans ton inventaire.§r\n\n" +
          "1. Ferme ce menu (Échap) et édite le livre.\n" +
          "2. Ne le signe pas.\n" +
          "3. Retape §alinucraft§r et choisis :\n\n" +
          "§8(un saut de page = un saut de ligne)§r"
      )
      .button("Enregistrer")
      .button("Annuler");
  } catch (e) {
    player.sendMessage(`§clinucraft: nano: ${e}`);
    return;
  }
  session.formOpen = true;

  form
    .show(player)
    .then((res) => {
      session.formOpen = false;
      if (res.canceled) {
        if (res.cancelationReason === "UserBusy")
          system.runTimeout(() => showNanoForm(session, req), 10);
        // UserClosed (Échap) : l'édition continue, l'appel reste pendant.
        return;
      }
      finishBookEdit(session, req, res.selection === 0);
    })
    .catch((e) => {
      session.formOpen = false;
      player.sendMessage(`§clinucraft: nano: ${e}`);
    });
}

// Enregistrer (save=true) ou Annuler : reprend le livre et complète l'appel.
function finishBookEdit(session, req, save) {
  const { player, machine } = session;
  let result;
  try {
    const found = takeNanoBook(player, req.payload.path);
    if (!save) result = { saved: false };
    else if (!found) result = { error: "livre introuvable — édition annulée" };
    else if (!found.pages) result = { error: "livre illisible (signé ?) — édition annulée" };
    else result = { saved: true, pages: found.pages };
  } catch (e) {
    result = { error: `lecture du livre impossible: ${e}` };
  }
  if (!machine.kernel.completeHostCall(req.id, result)) {
    // Le processus est mort entre-temps (kill) : le livre est déjà repris.
    try {
      player.sendMessage("§7nano: la session a expiré, livre repris.");
    } catch {}
  }
}

// Retrouve le livre conjuré (par nameTag exact), le RETIRE de l'inventaire et
// renvoie { pages } ({ pages:null } si illisible). null si introuvable.
function takeNanoBook(player, path) {
  const container = player.getComponent("minecraft:inventory")?.container;
  if (!container) return null;
  const tag = NANO_MARK + path;
  for (let i = 0; i < container.size; i++) {
    const item = container.getItem(i); // copie de lecture
    if (!item || item.nameTag !== tag) continue;
    let pages = null;
    try {
      const book = item.getComponent("minecraft:book");
      if (book && !book.isSigned) pages = book.contents.map((p) => p ?? "");
    } catch {}
    container.setItem(i, undefined); // reprend le livre
    return { pages };
  }
  return null;
}

// Retire les livres nano de l'inventaire, sauf ceux listés dans `keep`
// (nameTags des éditions encore en cours). Best-effort : jamais bloquant.
function sweepNanoBooks(player, keep = new Set()) {
  try {
    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) return;
    for (let i = 0; i < container.size; i++) {
      const item = container.getItem(i);
      if (!item || typeof item.nameTag !== "string") continue;
      if (!item.nameTag.startsWith(NANO_MARK)) continue;
      if (keep.has(item.nameTag)) continue;
      container.setItem(i, undefined);
    }
  } catch {}
}

// nameTags des livres appartenant aux éditions encore en cours (à épargner).
function keepTagsFor(machine, exceptId) {
  const keep = new Set();
  for (const r of machine.kernel.hostCalls())
    if (r.kind === "bookEdit" && r.id !== exceptId) keep.add(NANO_MARK + r.payload.path);
  return keep;
}
