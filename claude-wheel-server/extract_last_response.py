#!/usr/bin/env python3
"""
Stop hook: reads last assistant text from the current session's transcript
and writes it to the tmux session log.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path


def get_tmux_session() -> str | None:
    result = subprocess.run(
        ["tmux", "display-message", "-p", "#S"],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        return result.stdout.strip() or None
    return None


def find_transcript(session_id: str) -> Path | None:
    projects_dir = Path.home() / ".claude" / "projects"
    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        candidate = project_dir / f"{session_id}.jsonl"
        if candidate.exists():
            return candidate
    return None


def extract_last_exchange(transcript: Path) -> tuple[str | None, str | None, str | None]:
    """Return (msg_id, user_text, assistant_text) of the last exchange."""
    last_id = None
    last_user = None
    last_assistant = None
    with open(transcript) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg = entry.get("message", {})
            role = msg.get("role")
            if role == "user":
                content = msg.get("content", [])
                if isinstance(content, str):
                    last_user = content.strip()
                elif isinstance(content, list):
                    texts = [c["text"] for c in content if isinstance(c, dict) and c.get("type") == "text"]
                    if texts:
                        last_user = "\n".join(texts).strip()
            elif role == "assistant":
                content = msg.get("content", [])
                texts = [c["text"] for c in content if isinstance(c, dict) and c.get("type") == "text"]
                if texts:
                    last_id = msg.get("id")
                    last_assistant = "\n".join(texts).strip()
    return last_id, last_user, last_assistant


def get_tmux_workdir(session: str) -> str | None:
    result = subprocess.run(
        ["tmux", "display-message", "-t", session, "-p", "#{pane_current_path}"],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        return result.stdout.strip() or None
    return None


def main():
    # Read hook stdin
    try:
        hook_input = json.loads(sys.stdin.read())
    except Exception:
        hook_input = {}

    session_id = hook_input.get("session_id", "")
    if not session_id:
        sys.exit(0)

    tmux_session = get_tmux_session()
    if not tmux_session:
        sys.exit(0)

    log_path = f"/tmp/claude_output_{tmux_session}.log"

    transcript = find_transcript(session_id)
    if not transcript:
        sys.exit(0)

    id_file = Path("/tmp/claude_last_msg_id.txt")
    try:
        last_id = id_file.read_text().strip()
    except Exception:
        last_id = None

    # Give Claude Code time to finish writing the transcript
    time.sleep(0.5)

    msg_id, user_text, assistant_text = extract_last_exchange(transcript)
    if not assistant_text or not msg_id:
        sys.exit(0)

    # Skip if this message was already written (compact/resume duplicate)
    if msg_id == last_id:
        sys.exit(0)

    id_file.write_text(msg_id)

    with open(log_path, "a") as f:
        f.write(f"{assistant_text}\nENDENDENDENDEND\n")

    # Append to conversation log depending on CONVERSATION_LOG setting
    conv_log_mode = os.environ.get("CONVERSATION_LOG", "discussion")
    workdir = get_tmux_workdir(tmux_session)
    if workdir and conv_log_mode != "off":
        if conv_log_mode == "all" or workdir.endswith("/discussion"):
            from datetime import datetime
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
            conv_log = Path(workdir) / ".conversation.txt"
            with open(conv_log, "a") as f:
                if user_text:
                    f.write(f"[User] {timestamp}\n{user_text}\n\n")
                f.write(f"[Claude]\n{assistant_text}\n\n---\n\n")


if __name__ == "__main__":
    main()
