#!/usr/bin/env bash
# Initialise un nouvel addon Minecraft Bedrock (Behavior Pack + Resource Pack).
#
# Génère l'arborescence complète, avec 4 UUID uniques (obligatoires pour que
# Minecraft accepte les packs) et un build_mcaddon.sh prêt à empaqueter.
#
# Usage :
#   init_addon.sh <nom> [--author "Nom"] [--description "..."] \
#                       [--min-engine "1.21.90"] [--dest <dossier_parent>] [--no-scripts]
#
# Exemple :
#   init_addon.sh mon_addon --author "Elmart38" --description "Mon super addon"
set -euo pipefail

# --- Valeurs par défaut ---
ADDON=""
AUTHOR="Anonymous"
DESCRIPTION=""
MIN_ENGINE_STR="1.21.90"
DEST=""
WITH_SCRIPTS=1

# --- Analyse des arguments ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --author)      AUTHOR="$2"; shift 2 ;;
    --description) DESCRIPTION="$2"; shift 2 ;;
    --min-engine)  MIN_ENGINE_STR="$2"; shift 2 ;;
    --dest)        DEST="$2"; shift 2 ;;
    --no-scripts)  WITH_SCRIPTS=0; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -n 12
      exit 0 ;;
    -*)
      echo "Option inconnue : $1" >&2; exit 1 ;;
    *)
      if [[ -z "$ADDON" ]]; then ADDON="$1"; shift
      else echo "Argument en trop : $1" >&2; exit 1; fi ;;
  esac
done

if [[ -z "$ADDON" ]]; then
  echo "Usage : $0 <nom> [--author ...] [--description ...] [--min-engine 1.21.90] [--dest DIR] [--no-scripts]" >&2
  exit 1
fi

# Nom de projet propre (lettres, chiffres, underscore) pour les dossiers *_BP/*_RP.
if ! [[ "$ADDON" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "Erreur : nom d'addon invalide '$ADDON'. Utilise lettres, chiffres et _ uniquement." >&2
  exit 1
fi

# Format min_engine_version : "1.21.90" -> "1, 21, 90"
if ! [[ "$MIN_ENGINE_STR" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Erreur : --min-engine invalide '$MIN_ENGINE_STR'. Format attendu X.Y.Z." >&2
  exit 1
fi
IFS='.' read -r E_MAJ E_MIN E_PAT <<< "$MIN_ENGINE_STR"
MIN_ENGINE_ARRAY="${E_MAJ}, ${E_MIN}, ${E_PAT}"

[[ -z "$DESCRIPTION" ]] && DESCRIPTION="Addon Minecraft Bedrock '${ADDON}', par ${AUTHOR}."

ROOT="${DEST:+$DEST/}$ADDON"
if [[ -e "$ROOT" ]]; then
  echo "Erreur : '$ROOT' existe déjà. Choisis un autre nom ou supprime-le d'abord." >&2
  exit 1
fi

BP_DIR="$ROOT/${ADDON}_BP"
RP_DIR="$ROOT/${ADDON}_RP"

# --- Génération d'UUID (v4) avec plusieurs solutions de repli ---
gen_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z'
  elif [[ -r /proc/sys/kernel/random/uuid ]]; then
    cat /proc/sys/kernel/random/uuid
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import uuid; print(uuid.uuid4())'
  else
    echo "Erreur : impossible de générer un UUID (installe uuidgen ou python3)." >&2
    exit 1
  fi
}

BP_HEADER_UUID=$(gen_uuid)   # identité du behavior pack
BP_SCRIPT_UUID=$(gen_uuid)   # module script du behavior pack
RP_HEADER_UUID=$(gen_uuid)   # identité du resource pack
RP_MODULE_UUID=$(gen_uuid)   # module resources du resource pack

# --- Création de l'arborescence ---
mkdir -p "$BP_DIR" "$RP_DIR" "$ROOT/build"
[[ "$WITH_SCRIPTS" -eq 1 ]] && mkdir -p "$BP_DIR/scripts"

# --- manifest.json.template du Behavior Pack ---
# Le behavior pack déclare une dépendance vers le resource pack (via son UUID),
# ce qui garantit qu'ils sont importés et activés ensemble.
{
  echo '{'
  echo '  "format_version": 2,'
  echo '  "header": {'
  echo "    \"name\": \"${ADDON} (Behavior, v{{VERSION_STR}})\","
  echo "    \"description\": \"${DESCRIPTION} (v{{VERSION_STR}})\","
  echo "    \"uuid\": \"${BP_HEADER_UUID}\","
  echo '    "version": [{{VERSION_ARRAY}}],'
  echo "    \"min_engine_version\": [${MIN_ENGINE_ARRAY}]"
  echo '  },'
  if [[ "$WITH_SCRIPTS" -eq 1 ]]; then
    echo '  "modules": ['
    echo '    {'
    echo '      "type": "script",'
    echo '      "language": "javascript",'
    echo "      \"uuid\": \"${BP_SCRIPT_UUID}\","
    echo '      "version": [{{VERSION_ARRAY}}],'
    echo '      "entry": "scripts/main.js"'
    echo '    }'
    echo '  ],'
    echo '  "dependencies": ['
    echo '    {'
    echo '      "module_name": "@minecraft/server",'
    echo '      "version": "2.1.0"'
    echo '    },'
    echo '    {'
    echo "      \"uuid\": \"${RP_HEADER_UUID}\","
    echo '      "version": [{{VERSION_ARRAY}}]'
    echo '    }'
    echo '  ]'
  else
    echo '  "modules": ['
    echo '    {'
    echo '      "type": "data",'
    echo "      \"uuid\": \"${BP_SCRIPT_UUID}\","
    echo '      "version": [{{VERSION_ARRAY}}]'
    echo '    }'
    echo '  ],'
    echo '  "dependencies": ['
    echo '    {'
    echo "      \"uuid\": \"${RP_HEADER_UUID}\","
    echo '      "version": [{{VERSION_ARRAY}}]'
    echo '    }'
    echo '  ]'
  fi
  echo '}'
} > "$BP_DIR/manifest.json.template"

# --- manifest.json.template du Resource Pack ---
{
  echo '{'
  echo '  "format_version": 2,'
  echo '  "header": {'
  echo "    \"name\": \"${ADDON} (Resources, v{{VERSION_STR}})\","
  echo "    \"description\": \"Textures de ${ADDON} (v{{VERSION_STR}}), par ${AUTHOR}.\","
  echo "    \"uuid\": \"${RP_HEADER_UUID}\","
  echo '    "version": [{{VERSION_ARRAY}}],'
  echo "    \"min_engine_version\": [${MIN_ENGINE_ARRAY}]"
  echo '  },'
  echo '  "modules": ['
  echo '    {'
  echo '      "type": "resources",'
  echo "      \"uuid\": \"${RP_MODULE_UUID}\","
  echo '      "version": [{{VERSION_ARRAY}}]'
  echo '    }'
  echo '  ]'
  echo '}'
} > "$RP_DIR/manifest.json.template"

# --- Script main.js minimal (si module script activé) ---
if [[ "$WITH_SCRIPTS" -eq 1 ]]; then
  cat > "$BP_DIR/scripts/main.js" <<EOF
import { world } from "@minecraft/server";

world.afterEvents.worldInitialize.subscribe(() => {
  console.warn("[${ADDON}] addon chargé.");
});
EOF
fi

# --- build_mcaddon.sh (générique, dérivé de ton projet linucraft) ---
cat > "$ROOT/build_mcaddon.sh" <<'BUILD_EOF'
#!/usr/bin/env bash
# Empaquette __ADDON___BP + __ADDON___RP dans build/__ADDON___vX.Y.Z.mcaddon
# Usage : ./build_mcaddon.sh <version>   ex : ./build_mcaddon.sh 1.0.0
set -euo pipefail
cd "$(dirname "$0")"

ADDON="__ADDON__"

# --- Validation de la version ---
VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage : $0 <version>  (ex : $0 1.0.0)" >&2
  exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Erreur : version invalide '$VERSION'. Format attendu : X.Y.Z (ex : 1.0.0)" >&2
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
OUT="build/${ADDON}_v${VERSION}.mcaddon"
rm -f "$OUT"

# --- Répertoire temporaire ---
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cp -r "${ADDON}_BP" "$TMP/${ADDON}_BP"
cp -r "${ADDON}_RP" "$TMP/${ADDON}_RP"

# --- Génération des manifests depuis les templates ---
for PACK in BP RP; do
  TEMPLATE="${ADDON}_${PACK}/manifest.json.template"
  DEST="$TMP/${ADDON}_${PACK}/manifest.json"
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
(cd "$TMP" && zip -r -q - "${ADDON}_BP" "${ADDON}_RP" \
  -x '*/.git/*' '*.DS_Store' '*.template') > "$OUT"

echo "OK -> $OUT"
echo "Ouvre-le côté Windows pour l'importer dans Minecraft."
BUILD_EOF

# Injecte le nom réel de l'addon dans le build script.
sed -i "s/__ADDON__/${ADDON}/g" "$ROOT/build_mcaddon.sh"
chmod +x "$ROOT/build_mcaddon.sh"

# --- .gitignore + build/.gitkeep ---
printf 'build/\n' > "$ROOT/.gitignore"
: > "$ROOT/build/.gitkeep"

# --- Résumé ---
echo "OK -> addon '${ADDON}' initialisé dans '$ROOT'"
echo ""
echo "Arborescence :"
echo "  $ROOT/"
echo "  ├── build_mcaddon.sh"
echo "  ├── .gitignore"
echo "  ├── build/"
echo "  ├── ${ADDON}_BP/manifest.json.template   (uuid header : ${BP_HEADER_UUID})"
[[ "$WITH_SCRIPTS" -eq 1 ]] && echo "  ├── ${ADDON}_BP/scripts/main.js"
echo "  └── ${ADDON}_RP/manifest.json.template   (uuid header : ${RP_HEADER_UUID})"
echo ""
echo "Prochaine étape :  cd '$ROOT' && ./build_mcaddon.sh 1.0.0"
