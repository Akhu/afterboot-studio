#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
export UV_CACHE_DIR="$PWD/.cache-ambiences/uv"
export HF_HOME="$PWD/.cache-ambiences/huggingface"
trap 'echo "Installation arrêtée. Consulte docs/ambiences.md. / Installation stopped. See docs/ambiences.md."' ERR
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "Ce lanceur nécessite un Mac Apple Silicon. / Apple Silicon Mac required."
  exit 1
fi
command -v uv >/dev/null || { echo "Installe uv : https://docs.astral.sh/uv/getting-started/installation/"; exit 1; }
command -v ffmpeg >/dev/null || { echo "Installe FFmpeg : brew install ffmpeg"; exit 1; }
REVISION=790793b89ddceea612be9ce42ff6830d18f6fa57
if [[ ! -d .stable-audio-src ]]; then
  git clone https://github.com/Stability-AI/stable-audio-3.git .stable-audio-src
  git -C .stable-audio-src checkout --detach "$REVISION"
fi
if [[ "$(git -C .stable-audio-src rev-parse HEAD)" != "$REVISION" ]]; then
  echo "Version des sources différente. Dossier conservé. / Source revision differs. Folder preserved."
  exit 1
fi
uv venv --python 3.11 --allow-existing .venv-ambiences
uv pip sync --python .venv-ambiences/bin/python requirements-ambiences.txt
echo "Validation réelle des deux modèles. ACE-Step doit être lancé et au repos."
echo "Real validation of both models. Start ACE-Step and leave it idle."
.venv-ambiences/bin/python scripts/validate-ambiences.py
echo "Prêt. Lance « Lancer le studio.command », puis ouvre Ambiances. / Ready. Open Ambiences in the studio."
