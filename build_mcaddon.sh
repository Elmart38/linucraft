#!/usr/bin/env bash
# Empaquette linucraft_BP + linucraft_RP dans linucraft.mcaddon (un .zip renommé).
set -euo pipefail
cd "$(dirname "$0")"

OUT="linucraft.mcaddon"
rm -f "$OUT"

if ! command -v zip >/dev/null 2>&1; then
  echo "Erreur : 'zip' n'est pas installé (essaie : sudo apt install zip)." >&2
  exit 1
fi

# Un .mcaddon contient les dossiers de packs à la racine de l'archive.
zip -r -q "$OUT" linucraft_BP linucraft_RP \
  -x '*/.git/*' '*.DS_Store'

echo "OK -> $OUT"
echo "Ouvre-le côté Windows pour l'importer dans Minecraft."
