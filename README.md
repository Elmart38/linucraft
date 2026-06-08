# linucraft — un terminal « Linux » dans Minecraft Bedrock

Addon (Behavior Pack + Resource Pack) qui ajoute un **terminal Linux simulé** dans
Minecraft Bedrock. On l'ouvre avec une commande, on tape des commandes de base, et le
système de fichiers est **sauvegardé dans le monde**.

> ⚠️ **Ce que c'est (et n'est pas).** Les addons Bedrock tournent dans un bac à sable
> JavaScript : impossible d'exécuter un vrai noyau Linux ou d'écrire de vrais fichiers dans
> `worlds/<monde>/...`. linucraft **simule** un shell + un système de fichiers en JS, persisté
> dans les *dynamic properties* du monde (donc par-monde, comme voulu). Le rendu et l'usage
> sont ceux d'un terminal ; le moteur, non.

## Lancer le terminal

- Commande : **`/linucraft:start`** (l'API Bedrock impose un namespace, d'où le `:`).
- Ou bien : taper **`linucraft`** dans le chat (sans `/`).

Un écran de boot avec le logo s'affiche → bouton **« Entrer dans le terminal »** → la fenêtre
du terminal s'ouvre (historique en haut, champ de saisie en bas). Tape une commande puis
valide ; la fenêtre se rouvre avec la sortie. Coche **« Quitter le terminal »** pour sortir.

## Commandes de la v1

`help` `pwd` `ls [-a] [chemin]` `cd [chemin]` `cat <fichier…>` `echo [texte] [> / >> fichier]`
`mkdir <dossier…>` `touch <fichier…>` `rm [-r] <chemin…>` `clear` `whoami` `uname [-a]`
`date` `history` `neofetch`

Chemins gérés : absolus (`/etc`), relatifs (`projets/notes`), `.`, `..`, et `~` (= ton home).
Redirection vers un fichier : `echo salut > note.txt`, `ls >> liste.txt`.

## Persistance & multi-joueurs

- Racine partagée (`/`, `/bin`, `/etc`, `/usr`, `/tmp`) commune à tous, stockée dans
  `linucraft:fs_root`.
- Chaque joueur a son propre `/home/<pseudo>`, stocké dans `linucraft:home_<id>`.
- **Limite v1 :** dans `/home`, un joueur ne voit que **son propre** dossier (les homes des
  autres sont stockés séparément et ne sont pas montés). La racine partagée, elle, est commune.
- Limite Bedrock : ~32 000 caractères par fichier de stockage → on garde les fichiers petits.

## Installation

L'addon = deux dossiers : `linucraft_BP` (comportement) et `linucraft_RP` (ressources).

### Méthode 1 — dossiers de développement (idéal pour itérer)

Sous WSL, le dossier Minecraft (Windows) est typiquement :

```
/mnt/c/Users/<TON_USER>/AppData/Local/Packages/Microsoft.MinecraftUWP_8wekyb3d8bbwe/LocalState/games/com.mojang/
```

Copie :
- `linucraft_BP` → `.../com.mojang/development_behavior_packs/`
- `linucraft_RP` → `.../com.mojang/development_resource_packs/`

### Méthode 2 — fichier `.mcaddon` (pour partager)

```
./build_mcaddon.sh      # crée linucraft.mcaddon
```

Double-clique sur `linucraft.mcaddon` (côté Windows) : Minecraft importe les deux packs.

### Activer dans un monde

Crée/édite un monde → **Packs de comportements** : ajoute « linucraft (Behavior) ». Le pack de
ressources s'ajoute automatiquement (dépendance). Aucune API beta à cocher (les *Custom
Commands* sont stables). Il faut **Minecraft ~1.21.90+**.

## Personnaliser

- **Logo** : remplace `linucraft_RP/textures/ui/linucraft_logo.png` (PNG carré, ~128–256 px).
- **Nom de la commande** : change `name: "linucraft:start"` dans
  [main.js](linucraft_BP/scripts/main.js) (garde un namespace, ex. `linucraft:start`).
- **Versions des modules** : si le pack refuse de charger, ajuste les versions de
  `@minecraft/server` / `@minecraft/server-ui` dans
  [manifest.json](linucraft_BP/manifest.json) selon ta version de Minecraft.
- **Ajouter une commande** : ajoute une entrée dans l'objet `commands` de
  [commands.js](linucraft_BP/scripts/commands.js) — signature `(session, args, fs) => string`.

## Architecture

```
linucraft_BP/
  manifest.json
  scripts/
    main.js       # enregistre /linucraft:start + alias chat
    terminal.js   # écran de boot (ActionForm) + boucle terminal (ModalForm)
    shell.js      # session, prompt, parsing, redirection, dispatch
    commands.js   # implémentations des commandes
    fs.js         # FS virtuel + persistance (dynamic properties)
linucraft_RP/
  manifest.json
  textures/ui/linucraft_logo.png
```
