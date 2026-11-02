#!/bin/bash
cd "$(dirname "$0")" || exit 1
bash scripts/setup-ambiences.sh
STABLE_STATUS=$?
if [ "$STABLE_STATUS" -ne 0 ]; then
  echo "Installation interrompue. Consulte le message ci-dessus avant de réessayer."
fi
read -r -p "Appuie sur Entrée pour fermer."
exit "$STABLE_STATUS"
