#!/usr/bin/env bash
# Empaquette linucraft_BP + linucraft_RP dans build/linucraft_vX.Y.Z.mcaddon
# Usage : ./build_mcaddon.sh <version>   ex : ./build_mcaddon.sh 1.0.1
set -euo pipefail
cd "$(dirname "$0")"

# --- Validation de la version ---
VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage : $0 <version>  (ex : $0 1.0.1)" >&2
  exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Erreur : version invalide '$VERSION'. Format attendu : X.Y.Z (ex : 1.0.1)" >&2
  exit 1
fi

# --- Dépendance zip ---
if ! command -v zip >/dev/null 2>&1; then
  echo "Erreur : 'zip' n'est pas installé (essaie : sudo apt install zip)." >&2
  exit 1
fi

# --- Calcul des placeholders ---
IFS='.' read -r V_MAJOR V_MINOR V_PATCH <<< "$VERSION"
VERSION_ARRAY="${V_MAJOR}, ${V_MINOR}, ${V_PATCH}"

# --- Dossier de sortie ---
mkdir -p build
OUT="build/linucraft_v${VERSION}.mcaddon"
rm -f "$OUT"

# --- Répertoire temporaire ---
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Copie des packs dans le répertoire temporaire
cp -r linucraft_BP "$TMP/linucraft_BP"
cp -r linucraft_RP "$TMP/linucraft_RP"

# --- Génération des manifests depuis les templates ---
for PACK in BP RP; do
  TEMPLATE="linucraft_${PACK}/manifest.json.template"
  DEST="$TMP/linucraft_${PACK}/manifest.json"
  if [[ ! -f "$TEMPLATE" ]]; then
    echo "Erreur : template manquant '$TEMPLATE'" >&2
    exit 1
  fi
  sed \
    -e "s/{{VERSION_STR}}/${VERSION}/g" \
    -e "s/{{VERSION_ARRAY}}/${VERSION_ARRAY}/g" \
    "$TEMPLATE" > "$DEST"
done

# --- Construction de l'archive ---
(cd "$TMP" && zip -r -q - linucraft_BP linucraft_RP \
  -x '*/.git/*' '*.DS_Store' '*.template') > "$OUT"

echo "OK -> $OUT"
echo "Ouvre-le côté Windows pour l'importer dans Minecraft."
