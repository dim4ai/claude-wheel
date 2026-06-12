#!/usr/bin/env python3
"""
Voice VPS — endpoints:
  POST /stt  — audio file → text (via Groq Whisper API)
  POST /tts  — text → audio mp3 (via Edge TTS)
"""

import asyncio
import contextlib
import difflib
import io
import os
import shutil
import subprocess
import tempfile
import time

import edge_tts
from dotenv import load_dotenv
from fastapi import FastAPI, File, Query, Request, UploadFile, HTTPException, Header, Depends, Body
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from groq import Groq
from transliterate import translit

load_dotenv()

# ── Config ─────────────────────────────────────────────────────────────────
GROQ_API_KEY   = os.environ.get("GROQ_API_KEY", "")
API_KEY        = os.environ.get("API_KEY", "")
WHISPER_MODEL  = os.environ.get("WHISPER_MODEL", "whisper-large-v3-turbo")

def _validate_api_key(key: str):
    errors = []
    if not key:
        errors.append("API_KEY is not set in .env")
    else:
        if len(key) < 20:
            errors.append("at least 20 characters")
        if not any(c.islower() for c in key):
            errors.append("at least one lowercase letter")
        if not any(c.isupper() for c in key):
            errors.append("at least one uppercase letter")
        if not any(c.isdigit() for c in key):
            errors.append("at least one digit")
    if errors:
        import secrets, string
        alphabet = string.ascii_letters + string.digits
        suggestion = ''.join(secrets.choice(alphabet) for _ in range(32))
        print("\n" + "="*60)
        print("❌  Weak API_KEY. Requirements: " + ", ".join(errors) + ".")
        print("\n💡  Use this generated key:")
        print(f"\n    API_KEY=\"{suggestion}\"")
        print("\n    Copy to .env and restart the server.")
        print("="*60 + "\n")
        raise SystemExit(1)

_validate_api_key(API_KEY)
STT_LANGUAGE   = os.environ.get("STT_LANGUAGE", "ru")  # set to empty string for auto-detect
ASK_TIMEOUT    = int(os.environ.get("ASK_TIMEOUT", "240"))
IDLE_TIMEOUT   = int(os.environ.get("IDLE_TIMEOUT", "1800"))  # 30 min default
SESSIONS_CONF  = os.path.join(os.path.dirname(__file__), os.environ.get("SESSIONS_LIST", "sessions-list.txt"))

# ── Session state ───────────────────────────────────────────────────────────
last_activity: dict[str, float] = {}
session_locks: dict[str, asyncio.Lock] = {}
sessions_conf_lock = asyncio.Lock()

def get_session_lock(session: str) -> asyncio.Lock:
    if session not in session_locks:
        session_locks[session] = asyncio.Lock()
    return session_locks[session]

def session_log(session: str) -> str:
    return f"/tmp/claude_output_{session}.log"

def load_sessions() -> dict[str, str]:
    """Load session name → directory from sessions.conf."""
    sessions = {}
    try:
        with open(SESSIONS_CONF) as f:
            for line in f:
                line = line.strip()
                if line and ':' in line:
                    name, _, path = line.partition(':')
                    sessions[name.strip()] = path.strip()
    except FileNotFoundError:
        pass
    return sessions

def is_running(session: str) -> bool:
    result = subprocess.run(["tmux", "has-session", "-t", session], capture_output=True)
    return result.returncode == 0

async def wait_for_claude_ready(session: str, timeout: int = 30):
    """Wait for Claude to load: first detect screen change, then wait for stability."""
    def capture():
        return subprocess.run(["tmux", "capture-pane", "-t", session, "-p"], capture_output=True, text=True).stdout

    deadline = time.time() + timeout

    # Phase 1: wait for screen to change from initial state (Claude started loading)
    initial = capture()
    while time.time() < deadline:
        await asyncio.sleep(1)
        if capture() != initial:
            break

    # Phase 2: wait for screen to stabilize (Claude finished loading)
    prev = ""
    stable_count = 0
    while time.time() < deadline:
        current = capture()
        if current and current == prev:
            stable_count += 1
            if stable_count >= 2:
                return
        else:
            stable_count = 0
        prev = current
        await asyncio.sleep(2)

def has_conversation_history(work_dir: str) -> bool:
    """Check if Claude has conversation history for this directory."""
    encoded = work_dir.replace('/', '-')
    claude_projects = os.path.expanduser(f"~/.claude/projects/{encoded}")
    if not os.path.isdir(claude_projects):
        return False
    return any(f.endswith('.jsonl') for f in os.listdir(claude_projects))

def ensure_running(session: str, work_dir: str) -> bool:
    """Start session if not running. Returns True if session was just started."""
    if not is_running(session):
        subprocess.run(["tmux", "new-session", "-d", "-s", session, "-c", work_dir])
        cmd = "claude --continue" if has_conversation_history(work_dir) else "claude"
        subprocess.run(["tmux", "send-keys", "-t", session, cmd, "Enter"])
        print(f"[session] started: {session} ({cmd})", flush=True)
        return True
    return False

def stop_session(session: str):
    subprocess.run(["tmux", "kill-session", "-t", session], capture_output=True)
    last_activity.pop(session, None)
    print(f"[session] stopped: {session}", flush=True)

# ───────────────────────────────────────────────────────────────────────────

app = FastAPI()
groq_client = Groq(api_key=GROQ_API_KEY)

_HALLUCINATIONS = {
    "продолжение следует", "продолжение следует...", "субтитры сделал дина нечаева",
    "субтитры добавил дина нечаева", "редактор субтитров", "www.tvsubtitles.net",
    "спасибо за просмотр", "подпишитесь на канал",
}

def is_hallucination(text: str) -> bool:
    return text.strip().lower().rstrip('.').strip() in _HALLUCINATIONS


# ── Auth ────────────────────────────────────────────────────────────────────

def verify_key(x_api_key: str = Header(None), api_key: str = Query(None)):
    key = x_api_key or api_key
    if key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")

def get_groq_client(x_groq_api_key: str = Header(None)) -> Groq:
    """Return a Groq client using the per-request key if provided, otherwise the server default."""
    if x_groq_api_key:
        return Groq(api_key=x_groq_api_key)
    return groq_client


# ── STT endpoint ────────────────────────────────────────────────────────────

@app.post("/stt")
async def speech_to_text(audio: UploadFile = File(...), language: str = Query(None), _=Depends(verify_key), client: Groq = Depends(get_groq_client)):
    """Receive audio file, return transcribed text via Groq Whisper."""
    lang = language or STT_LANGUAGE  # request param overrides default
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp_path = f.name
        f.write(await audio.read())

    try:
        with open(tmp_path, "rb") as f:
            kwargs = {"model": WHISPER_MODEL, "file": f}
            if lang:
                kwargs["language"] = lang
            result = client.audio.transcriptions.create(**kwargs)
        text = result.text.strip()
        if is_hallucination(text):
            return {"text": ""}
        return {"text": text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        os.unlink(tmp_path)


# ── TTS endpoint ────────────────────────────────────────────────────────────

EDGE_TTS_VOICES = {
    'ru': {'female': 'ru-RU-SvetlanaNeural', 'male': 'ru-RU-DmitryNeural'},
    'en': {'female': 'en-US-AriaNeural',      'male': 'en-US-GuyNeural'},
    'de': {'female': 'de-DE-KatjaNeural',     'male': 'de-DE-ConradNeural'},
    'fr': {'female': 'fr-FR-DeniseNeural',    'male': 'fr-FR-HenriNeural'},
    'es': {'female': 'es-ES-ElviraNeural',    'male': 'es-ES-AlvaroNeural'},
    'zh': {'female': 'zh-CN-XiaoxiaoNeural',  'male': 'zh-CN-YunxiNeural'},
    'ja': {'female': 'ja-JP-NanamiNeural',    'male': 'ja-JP-KeitaNeural'},
}

@app.api_route("/tts", methods=["GET", "POST"])
async def text_to_speech(
    request: Request,
    text: str = Query(None),
    _=Depends(verify_key),
):
    language = 'ru'
    gender = 'female'
    if request.method == "POST":
        try:
            body = await request.json()
            text = body.get("text", text)
            language = body.get("language", "ru")
            gender = body.get("gender", "female")
        except Exception:
            pass
    if text is None:
        raise HTTPException(status_code=400, detail="text parameter required")

    voices = EDGE_TTS_VOICES.get(language, EDGE_TTS_VOICES['en'])
    voice = voices.get(gender, voices['female'])
    try:
        communicate = edge_tts.Communicate(text, voice)
        mp3_buf = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                mp3_buf.write(chunk["data"])
        mp3_buf.seek(0)
        return StreamingResponse(mp3_buf, media_type="audio/mpeg")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Ask endpoint ────────────────────────────────────────────────────────────

class AskRequest(BaseModel):
    text: str

@app.post("/ask")
async def ask_claude(body: AskRequest, session: str = Query(...), lock: bool = Query(True), _=Depends(verify_key)):
    """Send text to Claude tmux session, wait for response, return it."""
    sessions_conf = load_sessions()
    if session not in sessions_conf:
        raise HTTPException(status_code=404, detail=f"Session '{session}' not found")

    work_dir = sessions_conf[session]

    async with (get_session_lock(session) if lock else contextlib.AsyncExitStack()):
        just_started = ensure_running(session, work_dir)
        if just_started:
            await wait_for_claude_ready(session)
        last_activity[session] = time.time()

        log_path = session_log(session)

        # Clear log
        open(log_path, "w").close()

        # Exit copy-mode if pane is in it
        pane_mode = subprocess.run(
            ["tmux", "display-message", "-t", session, "-p", "#{pane_in_mode}"],
            capture_output=True, text=True
        )
        if pane_mode.stdout.strip() == "1":
            subprocess.run(["tmux", "send-keys", "-t", session, "-X", "cancel"], capture_output=True)
            time.sleep(0.2)

        # Inject text into tmux via temp file (reliable for long text)
        tmp_input = f"/tmp/claude_tmux_input_{session}.txt"
        with open(tmp_input, "w") as f:
            f.write(body.text)
        subprocess.run(["tmux", "load-buffer", tmp_input], capture_output=True)
        result = subprocess.run(["tmux", "paste-buffer", "-t", session], capture_output=True, text=True)
        if result.returncode != 0:
            raise HTTPException(status_code=503, detail="Session unavailable. Make sure Claude is running, or switch to another session.")
        time.sleep(0.2)
        subprocess.run(["tmux", "send-keys", "-t", session, "\r"], capture_output=True)

        # Poll for terminator
        deadline = time.time() + ASK_TIMEOUT
        while time.time() < deadline:
            await asyncio.sleep(0.5)
            try:
                with open(log_path, "r") as f:
                    content = f.read()
            except FileNotFoundError:
                continue
            if "ENDENDENDENDEND" in content:
                response = content.split("ENDENDENDENDEND")[0].strip()
                return {"text": response}

    raise HTTPException(status_code=504, detail="Claude response timeout")


# ── Dispatch endpoint ───────────────────────────────────────────────────────

PROJECT_TEMPLATE = os.path.join(os.path.dirname(SESSIONS_CONF), "..", "templates", "new-project")

def _trust_session(name: str, path: str):
    """Start Claude in a tmux session to accept trust prompt, then kill it."""
    subprocess.run(["tmux", "new-session", "-d", "-s", name, "-c", path])
    subprocess.run(["tmux", "send-keys", "-t", name, "claude", "Enter"])
    time.sleep(3)
    subprocess.run(["tmux", "send-keys", "-t", name, "Enter", ""])
    time.sleep(1)
    subprocess.run(["tmux", "kill-session", "-t", name], capture_output=True)

@app.post("/dispatch")
async def dispatch(action: str = Query(...), session: str = Query(None), dir: str = Query(None), project_mode: str = Query(None), new_name: str = Query(None), _=Depends(verify_key)):
    """Manage Claude tmux sessions."""
    sessions_conf = load_sessions()

    if action == "list":
        result = subprocess.run(["tmux", "ls", "-F", "#{session_name}"], capture_output=True, text=True)
        running = set(result.stdout.strip().splitlines()) if result.returncode == 0 else set()
        return {
            "sessions": [
                {"name": name, "dir": path, "running": name in running}
                for name, path in sessions_conf.items()
            ],
        }

    if action == "switch":
        # Client-side only now — server just validates the session exists
        if not session:
            raise HTTPException(status_code=400, detail="session required")
        session = session.lower().strip()

        if session not in sessions_conf:
            try:
                session_latin = translit(session, 'ru', reversed=True)
            except Exception:
                session_latin = session
            matches = difflib.get_close_matches(session_latin, sessions_conf.keys(), n=1, cutoff=0.7)
            if matches:
                session = matches[0]
            else:
                raise HTTPException(status_code=404, detail=f"Session '{session}' not in sessions.conf")

        print(f"[dispatch] client switched to: {session}", flush=True)
        return {"ok": True, "session": session}

    if action == "stop":
        if not session:
            raise HTTPException(status_code=400, detail="session required")
        if session not in sessions_conf:
            raise HTTPException(status_code=404, detail=f"Session '{session}' not found")
        stop_session(session)
        return {"ok": True}

    if action == "recreate":
        if not session:
            raise HTTPException(status_code=400, detail="session required")
        session = session.lower().strip()

        if session not in sessions_conf:
            raise HTTPException(status_code=404, detail=f"Session '{session}' not in sessions.conf")

        work_dir = sessions_conf[session]
        new_name = f"{session}_new"
        subprocess.run(["tmux", "new-session", "-d", "-s", new_name, "-c", work_dir])
        subprocess.run(["tmux", "send-keys", "-t", new_name, "claude", "Enter"])
        if is_running(session):
            subprocess.run(["tmux", "kill-session", "-t", session], capture_output=True)
        subprocess.run(["tmux", "rename-session", "-t", new_name, session], capture_output=True)
        last_activity[session] = time.time()
        print(f"[dispatch] recreated: {session}", flush=True)
        return {"ok": True, "session": session}

    if action == "create":
        if not session:
            raise HTTPException(status_code=400, detail="session required")
        session = session.strip().lower()
        work_dir = (dir.strip() if dir else None) or os.path.expanduser("~")

        if project_mode and os.path.isdir(PROJECT_TEMPLATE):
            # Copy template (creates lab/ and discussion/ subfolders)
            if not os.path.exists(work_dir):
                shutil.copytree(PROJECT_TEMPLATE, work_dir)
            else:
                shutil.copytree(PROJECT_TEMPLATE, work_dir, dirs_exist_ok=True)

            lab_dir = os.path.join(work_dir, "lab")
            disc_dir = os.path.join(work_dir, "discussion")
            lab_name  = f"{session}-lab"
            disc_name = f"{session}-discussion"

            _trust_session(lab_name,  lab_dir)
            _trust_session(disc_name, disc_dir)

            async with sessions_conf_lock:
                with open(SESSIONS_CONF, "a") as f:
                    f.write(f"{lab_name}: {lab_dir}\n")
                    f.write(f"{disc_name}: {disc_dir}\n")

            print(f"[dispatch] created: {lab_name}, {disc_name}", flush=True)
            return {"ok": True, "sessions": [lab_name, disc_name]}
        else:
            os.makedirs(work_dir, exist_ok=True)
            check = subprocess.run(["tmux", "has-session", "-t", session], capture_output=True)
            if check.returncode == 0:
                raise HTTPException(status_code=409, detail=f"Session '{session}' already exists")
            _trust_session(session, work_dir)
            async with sessions_conf_lock:
                with open(SESSIONS_CONF, "a") as f:
                    f.write(f"{session}: {work_dir}\n")
            print(f"[dispatch] created: {session}", flush=True)
            return {"ok": True, "session": session}

    if action == "rename":
        if not session:
            raise HTTPException(status_code=400, detail="session required")
        new_name = (new_name or "").strip().lower()
        if not new_name:
            raise HTTPException(status_code=400, detail="new_name required")
        if session not in sessions_conf:
            raise HTTPException(status_code=404, detail=f"Session '{session}' not found")
        if new_name in sessions_conf:
            raise HTTPException(status_code=409, detail=f"Session '{new_name}' already exists")
        work_dir = sessions_conf[session]
        # rename tmux session if running
        if is_running(session):
            subprocess.run(["tmux", "rename-session", "-t", session, new_name], capture_output=True)
        # update sessions.conf
        async with sessions_conf_lock:
            try:
                with open(SESSIONS_CONF, "r") as f:
                    lines = f.readlines()
                with open(SESSIONS_CONF, "w") as f:
                    for line in lines:
                        if line.startswith(f"{session}:") or line.startswith(f"{session} :"):
                            f.write(f"{new_name}: {work_dir}\n")
                        else:
                            f.write(line)
            except FileNotFoundError:
                pass
        if session in last_activity:
            last_activity[new_name] = last_activity.pop(session)
        print(f"[dispatch] renamed: {session} → {new_name}", flush=True)
        return {"ok": True, "session": new_name}

    if action == "close":
        if not session:
            raise HTTPException(status_code=400, detail="session required")
        if session not in sessions_conf:
            raise HTTPException(status_code=404, detail=f"Session '{session}' not found")
        stop_session(session)
        async with sessions_conf_lock:
            try:
                with open(SESSIONS_CONF, "r") as f:
                    lines = f.readlines()
                with open(SESSIONS_CONF, "w") as f:
                    for line in lines:
                        if not line.startswith(f"{session}:") and not line.startswith(f"{session} :"):
                            f.write(line)
            except FileNotFoundError:
                pass
        print(f"[dispatch] closed: {session}", flush=True)
        return {"ok": True}

    raise HTTPException(status_code=400, detail=f"Unknown action: {action}")


# ── Screen endpoint ─────────────────────────────────────────────────────────

@app.get("/screen")
def screen(session: str = Query(...), start: int = Query(0), count: int = Query(80), _=Depends(verify_key)):
    """Return terminal scrollback. start=lines from bottom (0=most recent), count=number of lines."""
    if session not in load_sessions():
        raise HTTPException(status_code=404, detail=f"Session '{session}' not found")
    if not is_running(session):
        raise HTTPException(status_code=503, detail="Session not running.")
    cmd = ["tmux", "capture-pane", "-t", session, "-p", "-S", str(-(start + count))]
    if start > 0:
        cmd += ["-E", str(-start)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise HTTPException(status_code=503, detail="Failed to capture screen")
    return {"screen": result.stdout, "start": start, "count": count}


# ── Keypress endpoint ────────────────────────────────────────────────────────

ALLOWED_KEYS = {"Up", "Down", "Enter", "Escape"}

@app.post("/keypress")
def keypress(key: str = Query(...), session: str = Query(...), _=Depends(verify_key)):
    """Send a keypress to the session."""
    if session not in load_sessions():
        raise HTTPException(status_code=404, detail=f"Session '{session}' not found")
    if key not in ALLOWED_KEYS:
        raise HTTPException(status_code=400, detail=f"Key must be one of: {ALLOWED_KEYS}")
    if not is_running(session):
        raise HTTPException(status_code=503, detail="Session not running.")
    tmux_key = "\x1b" if key == "Escape" else key
    result = subprocess.run(
        ["tmux", "send-keys", "-t", session, tmux_key, ""],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise HTTPException(status_code=503, detail="Failed to send key")
    if key == "Escape":
        with open(session_log(session), "a") as f:
            f.write("Request cancelled by user.\nENDENDENDENDEND\n")
    return {"ok": True, "key": key}


# ── Shell session endpoints ──────────────────────────────────────────────────

@app.get("/shell-sessions")
def shell_sessions(_=Depends(verify_key)):
    """Return list of all tmux sessions."""
    result = subprocess.run(
        ["tmux", "list-sessions", "-F", "#{session_name}"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        return {"sessions": []}
    names = [s for s in result.stdout.strip().splitlines() if s]
    return {"sessions": names}


@app.get("/shell-screen")
def shell_screen(session: str = Query(...), start: int = Query(0), count: int = Query(80), _=Depends(verify_key)):
    """Return terminal output for any tmux session."""
    cmd = ["tmux", "capture-pane", "-t", session, "-p", "-S", str(-(start + count))]
    if start > 0:
        cmd += ["-E", str(-start)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise HTTPException(status_code=404, detail=f"Session '{session}' not found")
    return {"screen": result.stdout, "start": start, "count": count}


@app.post("/shell-input")
def shell_input(session: str = Query(...), body: dict = Body(...), _=Depends(verify_key)):
    """Send text input to a tmux session. key= for special keys, raw=true to send without Enter."""
    text = body.get("text", "")
    key  = body.get("key", "")
    raw  = body.get("raw", False)
    if key:
        args = ["tmux", "send-keys", "-t", session, key, ""]
    elif raw:
        args = ["tmux", "send-keys", "-t", session, text, ""]
    else:
        args = ["tmux", "send-keys", "-t", session, text, "Enter"]
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        raise HTTPException(status_code=404, detail=f"Session '{session}' not found")
    return {"ok": True}


@app.post("/shell-create")
def shell_create(body: dict = Body(...), _=Depends(verify_key)):
    """Create a new tmux session, optionally starting in a given directory."""
    import os
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    start_dir = body.get("dir", "").strip()
    if not start_dir or not os.path.isdir(start_dir):
        start_dir = os.path.expanduser("~")
    result = subprocess.run(
        ["tmux", "new-session", "-d", "-s", name, "-c", start_dir],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise HTTPException(status_code=400, detail=f"Failed to create session: {result.stderr.strip()}")
    return {"ok": True, "name": name}


@app.delete("/shell-session")
def shell_delete(session: str = Query(...), _=Depends(verify_key)):
    """Kill a tmux shell session."""
    result = subprocess.run(
        ["tmux", "kill-session", "-t", session],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise HTTPException(status_code=404, detail=f"Session not found or already closed: {result.stderr.strip()}")
    return {"ok": True, "name": session}


# ── Auto-close idle sessions ────────────────────────────────────────────────

async def _idle_watcher():
    while True:
        await asyncio.sleep(60)
        now = time.time()
        known = set(load_sessions().keys())
        for session, ts in list(last_activity.items()):
            if session not in known:
                continue
            if now - ts > IDLE_TIMEOUT and is_running(session):
                print(f"[idle] closing inactive session: {session}", flush=True)
                stop_session(session)

@app.on_event("startup")
async def startup():
    # Register already-running Claude sessions so idle watcher can track them
    known = set(load_sessions().keys())
    result = subprocess.run(["tmux", "ls", "-F", "#{session_name}"], capture_output=True, text=True)
    if result.returncode == 0:
        for name in result.stdout.strip().splitlines():
            if name in known:
                last_activity[name] = time.time()
    asyncio.create_task(_idle_watcher())


# ── Health check ────────────────────────────────────────────────────────────

SERVER_VERSION = "1.1.2"

@app.get("/health")
def health():
    return {"status": "ok", "version": SERVER_VERSION, "stt": WHISPER_MODEL, "tts": "edge-tts"}
