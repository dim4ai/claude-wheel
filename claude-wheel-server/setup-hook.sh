#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_CMD="python3 $REPO_DIR/extract_last_response.py"
SETTINGS="$HOME/.claude/settings.json"

echo "Claude Wheel — Stop Hook setup"
echo "Directory: $REPO_DIR"
echo "Settings:  $SETTINGS"
echo ""

# Create ~/.claude if missing
mkdir -p "$HOME/.claude"

# Create settings.json if missing
if [ ! -f "$SETTINGS" ]; then
  echo '{}' > "$SETTINGS"
fi

# Register hook (overwrite any existing extract_last_response.py entry)
python3 - <<PYEOF
import json, re

settings_path = "$SETTINGS"
hook_cmd = "$HOOK_CMD"

with open(settings_path) as f:
    settings = json.load(f)

if "hooks" not in settings:
    settings["hooks"] = {}

# Remove any existing Stop hooks that reference extract_last_response.py
stop_hooks = settings["hooks"].get("Stop", [])
stop_hooks = [h for h in stop_hooks if not any(
    "extract_last_response.py" in c.get("command", "")
    for c in h.get("hooks", [])
)]

stop_hooks.append({"hooks": [{"type": "command", "command": hook_cmd}]})
settings["hooks"]["Stop"] = stop_hooks

with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2, ensure_ascii=False)
    f.write("\n")

print("✅  Stop Hook registered in", settings_path)
PYEOF
