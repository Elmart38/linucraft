import { system, world, CommandPermissionLevel } from "@minecraft/server";
import { openLincraft } from "./terminal.js";

// ---------------------------------------------------------------------------
// Point d'entrée de lincraft.
//   - commande /lincraft:start  (API Custom Commands, namespace obligatoire)
//   - alias chat : taper "lincraft" (sans /) ouvre aussi le terminal
// ---------------------------------------------------------------------------

// Enregistrement de la commande personnalisée (doit se faire au démarrage).
system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
  customCommandRegistry.registerCommand(
    {
      name: "lincraft:start",
      description: "Ouvre le terminal lincraft",
      permissionLevel: CommandPermissionLevel.Any,
    },
    (origin) => {
      const player = origin.sourceEntity;
      if (player && player.typeId === "minecraft:player") {
        // L'ouverture d'un formulaire doit être différée hors de l'event.
        system.run(() => openLincraft(player));
        return { status: 0, message: "Démarrage de lincraft…" };
      }
      return { status: 1, message: "lincraft doit être lancé par un joueur." };
    }
  );
});

// Alias chat : « lincraft » (sans slash) ouvre le terminal.
world.beforeEvents.chatSend.subscribe((ev) => {
  if (ev.message.trim().toLowerCase() === "lincraft") {
    ev.cancel = true;
    const player = ev.sender;
    system.run(() => openLincraft(player));
  }
});
