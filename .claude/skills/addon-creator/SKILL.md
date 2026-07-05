---
name: addon-creator
description: >-
  Initialise (scaffold) un nouvel addon Minecraft Bedrock : les dossiers
  Behavior Pack (BP) et Resource Pack (RP) avec leur manifest.json.template, le
  dossier build/, et un build_mcaddon.sh qui empaquette le tout en .mcaddon.
  Utilise ce skill dès que l'utilisateur veut démarrer / créer / initialiser un
  addon, un mod, un behavior pack ou un resource pack Minecraft Bedrock — même
  s'il ne dit pas explicitement « addon-creator » ni « scaffold ». Déclenche
  aussi sur « nouveau projet mcaddon », « BP/RP », « manifest Bedrock ».
---

# addon-creator

Initialise l'ossature complète d'un addon Minecraft Bedrock, en s'inspirant de
la structure du projet linucraft (behavior pack + resource pack liés,
manifests générés à partir de templates versionnés, empaquetage en `.mcaddon`).

## Ce qui est généré

```
<nom>/
├── build_mcaddon.sh              # empaquette BP + RP en build/<nom>_vX.Y.Z.mcaddon
├── .gitignore                    # ignore build/
├── build/                        # sortie des .mcaddon (avec .gitkeep)
├── <nom>_BP/                     # Behavior Pack
│   ├── manifest.json.template    # UUID uniques + placeholders de version
│   └── scripts/main.js           # point d'entrée script minimal
└── <nom>_RP/                     # Resource Pack
    └── manifest.json.template
```

## Comment procéder

1. **Demande le nom** de l'addon s'il n'est pas fourni (lettres, chiffres, `_`
   uniquement — il sert de préfixe aux dossiers `<nom>_BP` / `<nom>_RP`).
   Récupère aussi l'auteur et une description courte si l'utilisateur les donne ;
   sinon des valeurs par défaut sont utilisées.

2. **Lance le script d'initialisation** — il fait tout le travail, y compris la
   génération des 4 UUID uniques (voir plus bas pourquoi c'est important) :

   ```bash
   .claude/skills/addon-creator/scripts/init_addon.sh <nom> \
     --author "<auteur>" --description "<description>"
   ```

   Options utiles :
   - `--min-engine 1.21.90` : version minimale du moteur (défaut `1.21.90`).
   - `--dest <dossier>` : crée l'addon dans un dossier parent donné (défaut : dossier courant).
   - `--no-scripts` : behavior pack de données pures, sans module script `@minecraft/server`.

3. **Montre l'arborescence** produite (le script l'affiche) et indique la
   commande de build : `cd <nom> && ./build_mcaddon.sh 1.0.0`.

## Points importants (le pourquoi)

- **Chaque pack a besoin d'UUID uniques.** Un manifest Bedrock exige un UUID de
  header et un UUID par module. Copier-coller un manifest existant sans changer
  les UUID fait échouer l'import dans Minecraft (conflit d'identité). Le script
  génère automatiquement 4 UUID v4 distincts — ne les réutilise jamais d'un
  addon à l'autre.

- **Le BP dépend du RP.** Le template du behavior pack déclare une dépendance
  vers l'UUID de header du resource pack, pour que les deux soient importés et
  activés ensemble par le joueur.

- **Les versions ne sont pas en dur.** Les manifests sont des `.template` avec
  les placeholders `{{VERSION_STR}}` (ex. `1.0.0`) et `{{VERSION_ARRAY}}`
  (ex. `1, 0, 0`). C'est `build_mcaddon.sh <version>` qui les remplace via `sed`
  au moment de l'empaquetage, puis zippe en `.mcaddon`. Ainsi une seule commande
  fixe la version partout de façon cohérente.

- **Pas de `pack_icon.png` généré.** Minecraft affiche une icône par défaut sans
  lui. Si l'utilisateur en veut un, il ajoute un `pack_icon.png` (256×256
  conseillé) à la racine de chaque pack — inutile de l'inventer.
