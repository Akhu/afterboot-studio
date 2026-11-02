#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
STABLE_RUNTIME="$PWD/.stable-audio"
mkdir -p "$STABLE_RUNTIME"
STABLE_UV="$(command -v uv || true)"
if [ -z "$STABLE_UV" ]; then
  if [ ! -x "$STABLE_RUNTIME/bin/uv" ]; then
    curl --fail --location --silent --show-error https://astral.sh/uv/install.sh -o "$STABLE_RUNTIME/install-uv.sh"
    UV_INSTALL_DIR="$STABLE_RUNTIME/bin" UV_NO_MODIFY_PATH=1 sh "$STABLE_RUNTIME/install-uv.sh"
  fi
  STABLE_UV="$STABLE_RUNTIME/bin/uv"
fi
"$STABLE_UV" venv --python 3.12 "$STABLE_RUNTIME/.venv" --allow-existing
# Pin the upstream API we integrate with, rather than silently following main.
"$STABLE_UV" pip install --python "$STABLE_RUNTIME/.venv/bin/python" \
  'stable-audio-3 @ git+https://github.com/Stability-AI/stable-audio-3.git@790793b89ddceea612be9ce42ff6830d18f6fa57'
"$STABLE_RUNTIME/.venv/bin/python" scripts/stable_audio_worker.py --check
echo "Stable Audio est installé. Les poids seront téléchargés à la première prise."
echo "Si l'accès est refusé, accepte les conditions des deux modèles sur Hugging Face, puis :"
echo "  .stable-audio/.venv/bin/hf auth login"
