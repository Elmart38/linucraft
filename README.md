# linucraft — un OS « Linux » dans Minecraft Bedrock

Addon (Behavior Pack + Resource Pack) qui fait tourner un **véritable petit
système d'exploitation** dans Minecraft Bedrock : un noyau multitâche, des
processus, des appels système, un shell avec pipes et scripts, un système de
fichiers avec permissions… et un **moteur JavaScript** pour écrire et exécuter
tes propres programmes, directement en jeu. Le tout persisté dans le monde.

> ⚠️ **Ce que c'est (et n'est pas).** Les addons Bedrock tournent dans un bac à
> sable JavaScript : impossible d'exécuter un vrai noyau Linux ou de toucher aux
> fichiers de `worlds/<monde>/...`. linucraft implémente son **propre** noyau en
> JS : les processus sont des générateurs ordonnancés au rythme des ticks, les
> programmes parlent au noyau par appels système, et le disque vit dans les
> *dynamic properties* du monde. Ce n'est pas Linux — mais ce n'est plus une
> simulation non plus : c'est un vrai OS, écrit pour cette plateforme.

## Installation et démarrage rapide

1. Télécharge le fichier [.mcaddon](https://github.com/Elmart38/linucraft/releases)
2. Double-clique sur le `.mcaddon` (côté Windows) : Minecraft importe les packs.
3. Commande : **`/linucraft:start`**

## Développement
Ce projet a été principalement codé en Vibe coding.

## Lancer le terminal

Commande : **`/linucraft:start`** (l'API Bedrock impose un namespace).

Écran de boot → bouton → le terminal s'ouvre (scrollback en haut, saisie en
bas). Chaque commande validée rouvre la fenêtre avec la sortie. **Échap** ferme
l'écran mais la machine continue en arrière-plan (retape `linucraft` pour t'y
rattacher) ; `exit` éteint la machine.

## Le shell (lsh)

Un vrai shell interprété (lexer → AST → évaluateur) :

```sh
ls /bin | grep c | wc -l            # pipes
echo salut > note.txt ; cat < note.txt >> copie.txt
export NOM=steve ; echo "salut $NOM ($(whoami))"
ls *.txt ; echo image?.png         # globs * ? [...]
true && echo oui || echo non       # opérateurs logiques, $?
if [ -f note.txt ]; then cat note.txt; fi
for f in *.txt; do echo "-> $f"; done
while [ ! -f stop ]; do sleep 1; done
sleep 30 &                          # arrière-plan, jobs, wait, kill <pid>
```

Scripts shell : écris un fichier commençant par `#!/bin/sh`, rends-le
exécutable (`chmod +x mon.sh`), lance `./mon.sh args` (ou `sh mon.sh`,
`source mon.sh`). Variables `$1..$n`, `$#`, `$?`, `$$` disponibles.

**`^C`** (tape littéralement `^C` dans le terminal) interrompt le programme
d'avant-plan — indispensable face à un `while true`. Les jobs `&` survivent.

## L'éditeur (`nano`)

Fini le `echo >>` ligne à ligne : `nano <fichier>` édite (ou crée) un fichier
via un **livre-plume éphémère** — la vraie zone de texte multiligne de Bedrock.

1. Le contenu du fichier est copié dans un livre-plume qui apparaît dans ton
   inventaire (impossible à jeter ou à déposer dans un coffre : il n'existe que
   le temps de l'édition).
2. Ferme le menu (Échap) et édite le livre dans l'interface native du jeu.
   **Ne le signe pas.**
3. Retape `linucraft` : le formulaire nano revient → **Enregistrer** écrit le
   fichier et reprend le livre ; **Annuler** laisse le fichier intact.

Conventions : un saut de page équivaut à un saut de ligne. Limites héritées du
livre Bedrock : 50 pages, et l'éditeur n'affiche que 14 lignes par page — nano
empaquette le fichier en conséquence (lignes de ~238 caractères max) pour que
chaque page reste entièrement visible et éditable.
Les permissions s'appliquent comme partout (`sudo nano /etc/motd` pour
un fichier root) ; en cas de déconnexion pendant une édition, le livre orphelin
est repris à la prochaine session.

## Le moteur JavaScript (`js` / `node`)

Le cœur du projet : un **interprète JavaScript écrit en JavaScript** (eval est
interdit dans le sandbox Bedrock), préemptible — une boucle infinie ne gèle
jamais le jeu, elle apparaît juste dans `ps` et se tue avec `kill`.

```sh
./hello.js               # un programme d'exemple est seedé dans ton home
js hello.js Elmart38        # ou via l'interpréteur explicitement
node                     # REPL interactif (.exit pour sortir)
```

Langage supporté : `let/const`, fonctions + fléchées + fermetures + récursion,
`if/for/for-of/for-in/while/do`, `try/catch/finally/throw`, objets + méthodes +
`this` + `new` + prototypes simples, templates `` `${}` ``, opérateurs
(y compris bit à bit), défauts et `...rest`. Les méthodes natives (`Math`,
`JSON`, chaînes, tableaux — `map/filter/reduce/sort` avec fermetures) marchent.
Non supporté (v1) : `class`, destructuring, spread, regex, async.

API « node-like » fournie aux programmes :

```js
#!/bin/js
const fs = require("fs");         // readFile, writeFile, readdir, mkdir, rm…
const path = require("path");     // join, dirname, basename, normalize…
const os = require("os");         // platform(), uptime(), sleep(ms)
const lib = require("./lib.js");  // tes modules, avec module.exports + cache
console.log(process.argv[2], process.env.USER, __filename);
process.exit(0);
```

Écris un programme en jeu avec `nano prog.js` (ou ligne à ligne via
`echo '...' >> prog.js`), puis `chmod +x prog.js` et `./prog.js` — ou lance-le
sans bit x via `js prog.js`.

## Le système (noyau, processus, FS)

- **Noyau coopératif** : un battement par tick de jeu ; chaque processus est un
  générateur JS dont chaque `yield` est un appel système ET un point de
  préemption. Budget de pas + garde temporel par tick : le watchdog Bedrock est
  respecté quoi que fassent les programmes.
- **Processus** : `ps`, `kill`, jobs `&`, `wait`, `/proc/<pid>/status`,
  `/proc/uptime`, codes de sortie, zombies récoltés par `wait`.
- **FS v2** : permissions `rwx` réelles (uid/gid, `chmod`, `chown`), symlinks
  (`ln -s`), `stat`, `df`, `du`, `/dev/null|zero|random`, `/tmp` en 777. Un
  utilisateur normal ne peut pas écrire dans `/etc` — `sudo cmd` ou `su`/`su -`
  (ouvre un shell root imbriqué, `exit` pour en ressortir ; `id`, prompt `#`).
  Chaque joueur a un **uid distinct et stable** dérivé de son identifiant.
- **Persistance chunkée** : le FS est découpé en morceaux sur plusieurs dynamic
  properties — la limite Bedrock de ~32 Ko **ne borne plus** la taille du
  système de fichiers.
- **Multi-joueurs** : racine partagée (`linucraft:fs_root`), un `/home/<pseudo>`
  privé par joueur (`linucraft:home_<id>`). Limite : on ne voit que son propre
  home.

## Tests (hors-jeu)

Le cœur de l'OS est du JS pur, sans dépendance à Minecraft : le harnais le
pilote tick par tick dans Node avec un stockage mémoire.

```sh
npm test        # ~150 tests : base, shell, FS/permissions, moteur JS
```

## Installation

L'addon = deux dossiers : `linucraft_BP` (comportement) et `linucraft_RP`
(ressources).

### Méthode 1 — dossiers de développement (idéal pour itérer)

Sous WSL, le dossier Minecraft (Windows) est typiquement :

```
/mnt/c/Users/<TON_USER>/AppData/Local/Packages/Microsoft.MinecraftUWP_8wekyb3d8bbwe/LocalState/games/com.mojang/
```

Copie :
- `linucraft_BP` → `.../com.mojang/development_behavior_packs/`
- `linucraft_RP` → `.../com.mojang/development_resource_packs/`

### Méthode 2 — fichier `.mcaddon` (pour partager)

```sh
./build_mcaddon.sh 2.0.0    # crée build/linucraft_v2.0.0.mcaddon
```

Double-clique sur le `.mcaddon` (côté Windows) : Minecraft importe les packs.

### Activer dans un monde

Crée/édite un monde → **Packs de comportements** : ajoute « linucraft ». Le pack
de ressources suit (dépendance). Aucune API beta à cocher. Minecraft ~1.21.100+
(module `@minecraft/server` 2.2.0, requis par `nano`/livre-plume).
Les mondes créés avec une ancienne version sont migrés (les nouveaux binaires
apparaissent dans `/bin` au chargement).

## Architecture

```
linucraft_BP/scripts/
  main.js            # enregistre /linucraft:start + alias chat
  terminal.js        # couche plateforme : ModalForm ⇄ TTY, runInterval → kernel.tick()
  os/
    kernel.js        # table de processus, ordonnanceur, syscalls, budget/tick
    syscalls.js      # les descripteurs d'appels système (yield SYS.open(...))
    backends.js      # TTY (+ ^C), fichiers, tubes, /dev/*
    vfs.js           # arbre de fichiers, permissions, symlinks, chunking
    stdlib.js        # ctx des programmes : fs/path/console/process (générateurs)
    errno.js         # codes d'erreur POSIX
    machine.js       # assemble vfs + tty + kernel (utilisé par le jeu ET les tests)
    bin/             # les programmes : sh.js (shell), js.js (moteur JS),
                     # coreutils.js (ls, cat, grep…), fsutils.js (chmod, stat…)
    js/              # le moteur JavaScript : lexer.js, parser.js, interp.js
test/                # harnais hors-jeu (npm test)
```

Chaque programme est un générateur `function* main(ctx)` isolé du monde : il ne
voit que des appels système (`yield ctx.sys.open(...)`). Pour ajouter une
commande : écris-la dans `os/bin/`, enregistre-la dans `os/bin/index.js`.

## Personnaliser

- **Logo** : remplace `linucraft_RP/textures/ui/linucraft_logo.png`.
- **Nom de la commande** : `name: "linucraft:start"` dans
  [main.js](linucraft_BP/scripts/main.js) (garde un namespace).
- **Versions des modules** : ajuste `@minecraft/server` / `@minecraft/server-ui`
  dans [manifest.json](linucraft_BP/manifest.json) si le pack refuse de charger.
