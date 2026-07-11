#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE=/etc/systemd/system/claude-wheel.service

PORT=$(grep -E '^PORT=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
PORT=${PORT:-11000}

if [ -f "$SERVICE_FILE" ]; then
  echo "Service already exists: $SERVICE_FILE"
  echo "To reinstall, remove it first: sudo rm $SERVICE_FILE"
  exit 0
fi

sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=Claude Wheel Server
After=network.target

[Service]
WorkingDirectory=$SCRIPT_DIR
ExecStart=$SCRIPT_DIR/venv/bin/uvicorn app:app --host 0.0.0.0 --port $PORT
Restart=always
User=$USER

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable claude-wheel
sudo systemctl start claude-wheel

echo "Claude Wheel service installed and started."
echo "Check status: systemctl status claude-wheel"

# Initialize watchdog directory trust (Claude asks on first run in a new directory)
WATCHDOG_SESSION=$(grep -E '^WATCHDOG_SESSION=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "cw-watchdog")
WATCHDOG_DIR="$SCRIPT_DIR/watchdog"
echo "Initializing watchdog trust: $WATCHDOG_DIR"
tmux new-session -d -s "$WATCHDOG_SESSION" -c "$WATCHDOG_DIR"
tmux send-keys -t "$WATCHDOG_SESSION" "claude" Enter
sleep 3
tmux send-keys -t "$WATCHDOG_SESSION" Enter ""
sleep 1
tmux kill-session -t "$WATCHDOG_SESSION" 2>/dev/null || true
echo "Watchdog initialized."

# Initialize format directory trust
FORMAT_SESSION=$(grep -E '^FORMAT_SESSION=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "cw-format")
FORMAT_DIR="$SCRIPT_DIR/format"
echo "Initializing format trust: $FORMAT_DIR"
tmux new-session -d -s "$FORMAT_SESSION" -c "$FORMAT_DIR"
tmux send-keys -t "$FORMAT_SESSION" "claude" Enter
sleep 3
tmux send-keys -t "$FORMAT_SESSION" Enter ""
sleep 1
tmux kill-session -t "$FORMAT_SESSION" 2>/dev/null || true
echo "Format initialized."
