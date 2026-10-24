#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE=/etc/systemd/system/claude-wheel-tts-proxy.service

if [ ! -d "$SCRIPT_DIR/venv" ]; then
  echo "venv not found — run this first:"
  echo "  cd $SCRIPT_DIR && python3 -m venv venv && venv/bin/pip install -r requirements.txt"
  exit 1
fi

if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo ".env not found — copy .env.example to .env and set API_KEY first."
  exit 1
fi

PORT=$(grep -E '^PORT=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
PORT=${PORT:-11010}

if [ -f "$SERVICE_FILE" ]; then
  echo "Service already exists: $SERVICE_FILE"
  echo "To reinstall, remove it first: sudo rm $SERVICE_FILE"
  exit 0
fi

sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=Claude Wheel TTS Proxy
After=network.target

[Service]
WorkingDirectory=$SCRIPT_DIR
ExecStart=$SCRIPT_DIR/venv/bin/uvicorn app:app --host 0.0.0.0 --port $PORT
Restart=always
KillMode=process
User=$USER

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable claude-wheel-tts-proxy
sudo systemctl start claude-wheel-tts-proxy

echo "claude-wheel-tts-proxy installed and started on port $PORT."
echo "Check status: systemctl status claude-wheel-tts-proxy"
