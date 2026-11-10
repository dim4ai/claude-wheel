"""Local (offline, no Microsoft) TTS fallback for when edge-tts / the proxy
comes back empty. Behind a small interface so the actual engine (currently
Piper, via onnxruntime — no torch needed) can be swapped out without
touching app.py: callers only ever use available() and synthesize().
"""
from __future__ import annotations

import io
import os
import wave
from abc import ABC, abstractmethod


class LocalTtsEngine(ABC):
    @abstractmethod
    def available(self, language: str) -> bool:
        """Whether this engine has a voice for the given language right now."""

    @abstractmethod
    def synthesize(self, text: str, language: str, gender: str) -> bytes:
        """Returns WAV bytes. Raises on failure — caller decides what to do."""


_MODELS_DIR = os.path.join(os.path.dirname(__file__), "local_tts_models")

# language -> gender -> piper voice name (models pre-downloaded into
# local_tts_models/ via `python -m piper.download_voices`)
_PIPER_VOICES = {
    "ru": {"female": "ru_RU-irina-medium", "male": "ru_RU-dmitri-medium"},
}


class PiperEngine(LocalTtsEngine):
    def __init__(self):
        self._voices: dict[str, object] = {}

    def _model_path(self, language: str, gender: str) -> str | None:
        name = _PIPER_VOICES.get(language, {}).get(gender)
        if not name:
            return None
        path = os.path.join(_MODELS_DIR, f"{name}.onnx")
        return path if os.path.exists(path) else None

    def available(self, language: str) -> bool:
        voices = _PIPER_VOICES.get(language, {})
        return any(self._model_path(language, g) for g in voices)

    def _load(self, model_path: str):
        voice = self._voices.get(model_path)
        if voice is None:
            from piper import PiperVoice  # imported lazily so a missing/not-yet-installed
            voice = PiperVoice.load(model_path)  # engine never breaks startup
            self._voices[model_path] = voice
        return voice

    def synthesize(self, text: str, language: str, gender: str) -> bytes:
        model_path = self._model_path(language, gender) or self._model_path(language, "female")
        if not model_path:
            raise RuntimeError(f"no local Piper voice for language={language!r}")
        voice = self._load(model_path)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            voice.synthesize_wav(text, wf)
        return buf.getvalue()


_engine: LocalTtsEngine = PiperEngine()


def available(language: str) -> bool:
    try:
        return _engine.available(language)
    except Exception:
        return False


def synthesize(text: str, language: str, gender: str) -> bytes:
    """Returns WAV bytes. Raises on failure."""
    return _engine.synthesize(text, language, gender)
