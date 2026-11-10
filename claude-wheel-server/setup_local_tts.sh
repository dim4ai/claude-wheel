#!/usr/bin/env bash
# One-time setup for local_tts.py's Piper fallback voices. Models aren't
# committed to git (binary, ~60MB each) — run this once per deploy.
set -euo pipefail
cd "$(dirname "$0")"
source venv/bin/activate
python -m piper.download_voices --download-dir local_tts_models \
  ru_RU-irina-medium ru_RU-dmitri-medium
