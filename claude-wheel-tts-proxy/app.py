#!/usr/bin/env python3
"""
Claude Wheel TTS proxy — one job: text -> mp3 via Edge TTS, from an IP that
isn't blocked by Microsoft. Runs on a separate VPS; claude-wheel-server calls
this instead of edge-tts directly when its own IP gets blocked.
"""

import io
import os

import edge_tts
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

load_dotenv()

API_KEY = os.environ.get("API_KEY", "")
if not API_KEY:
    raise SystemExit("API_KEY not set in .env — see .env.example")

app = FastAPI()


def verify_key(x_api_key: str = Header(None), api_key: str = Query(None)):
    if (x_api_key or api_key) != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


@app.get("/health")
def health():
    return {"ok": True}


@app.api_route("/tts", methods=["GET", "POST"])
async def text_to_speech(
    request: Request,
    text: str = Query(None),
    voice: str = Query("ru-RU-SvetlanaNeural"),
    _=Depends(verify_key),
):
    if request.method == "POST":
        try:
            body = await request.json()
            text = body.get("text", text)
            voice = body.get("voice", voice)
        except Exception:
            pass
    if not text:
        raise HTTPException(status_code=400, detail="text parameter required")
    try:
        communicate = edge_tts.Communicate(text, voice)
        buf = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                buf.write(chunk["data"])
        buf.seek(0)
        return StreamingResponse(buf, media_type="audio/mpeg")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
