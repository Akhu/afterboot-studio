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
echo "Garde cette fenêtre ouverte pendant l’utilisation du studio."
echo "L’API ACE-Step doit être lancée séparément sur le port 8001."
(sleep 1; open "http://127.0.0.1:3210") &
"$STUDIO_NODE" server.mjs
read -r -p "Appuie sur Entrée pour fermer."
