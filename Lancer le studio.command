#!/bin/bash
cd "$(dirname "$0")" || exit 1
STUDIO_NODE="$(command -v node || true)"
if [ -z "$STUDIO_NODE" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then
      major="$("$candidate" -p 'process.versions.node.split(".")[0]')"
      if [ "$major" -ge 20 ]; then
        STUDIO_NODE="$candidate"
        break
      fi
    fi
  done
fi
if [ -z "$STUDIO_NODE" ] || ! "$STUDIO_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "Installe Node.js 20 ou plus récent depuis https://nodejs.org, puis relance ce fichier."
  read -r -p "Appuie sur Entrée pour fermer."
  exit 1
fi
export PATH="$(dirname "$STUDIO_NODE"):$PATH"
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installation des composants du studio…"
  if ! npm ci --ignore-scripts --no-audit --no-fund; then
    read -r -p "Installation impossible. Appuie sur Entrée pour fermer."
    exit 1
  fi
fi
echo "Garde cette fenêtre ouverte pendant l’utilisation du studio."
echo "Musique : lance l’API ACE-Step séparément sur le port 8001."
echo "Ambiances : Stable Audio est lancé à la demande depuis l’onglet dédié."
(sleep 1; open "http://127.0.0.1:3210") &
"$STUDIO_NODE" server.mjs
read -r -p "Appuie sur Entrée pour fermer."
