import io
import wave
import logging
import os
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel
import numpy as np

try:  # Optional heavy dependency
    from TTS.api import TTS as CoquiTTS  # type: ignore
except Exception:  # pragma: no cover
    CoquiTTS = None


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tts_server")

MODEL_ID = os.getenv("TTS_MODEL", "tts_models/en/ljspeech/tacotron2-DDC")


def _init_tts():
    if CoquiTTS is None:
        return None
    try:
        return CoquiTTS(MODEL_ID)
    except Exception as ex:  # pragma: no cover
        logger.warning("TTS init failed: %s", ex)
        return None


tts = _init_tts()

if tts is None:
    class DummyTTS:
        """Fallback synthesizer producing a sine wave."""

        def __init__(self, sr: int = 22050):
            self.sample_rate = sr
            self.device = "cpu"

        def tts(self, text: str):
            duration = max(1.2, len(text) * 0.06)
            t = np.linspace(0, duration, int(self.sample_rate * duration), endpoint=False)
            return 0.2 * np.sin(2 * np.pi * 440 * t)

    tts = DummyTTS()

DEVICE = getattr(tts, "device", "cpu")
DEFAULT_SR = int(getattr(tts, "output_sample_rate", getattr(tts, "sample_rate", 22050)))
logger.info("TTS model=%s device=%s sample_rate=%s", MODEL_ID, DEVICE, DEFAULT_SR)


app = FastAPI()


class SpeakRequest(BaseModel):
    text: str
    sample_rate: int | None = None


def synthesize(text: str) -> np.ndarray:
    wav = tts.tts(text)
    wav = np.asarray(wav, dtype=np.float32)
    if wav.ndim > 1:
        wav = np.mean(wav, axis=1).astype(np.float32)
    return wav


def float32_to_wav_bytes(wav_f32: np.ndarray, sr: int) -> tuple[bytes, int]:
    pcm = (np.clip(wav_f32, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    bio = io.BytesIO()
    with wave.open(bio, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm)
    return bio.getvalue(), len(pcm)


@app.post("/speak")
def speak(req: SpeakRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    sr = int(req.sample_rate or DEFAULT_SR)
    try:
        wav = synthesize(text)
        data, _ = float32_to_wav_bytes(wav, sr)
        return Response(content=data, media_type="audio/wav", headers={"Cache-Control": "no-store"})
    except Exception as ex:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(ex))


@app.post("/speak_debug")
def speak_debug(req: SpeakRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    sr = int(req.sample_rate or DEFAULT_SR)
    try:
        wav = synthesize(text)
        data, pcm_len = float32_to_wav_bytes(wav, sr)
        duration = float(len(wav) / sr)
        warn = None
        if len(text) > 5 and duration < 0.9:
            warn = f"short duration {duration:.2f}s for text len {len(text)}"
            logger.warning(warn)
        resp = {
            "ok": True,
            "samples": int(len(wav)),
            "sample_rate": sr,
            "duration_sec": duration,
            "pcm_bytes": pcm_len,
        }
        if warn:
            resp["warning"] = warn
        return resp
    except Exception as ex:
        return JSONResponse({"ok": False, "error": str(ex)}, status_code=500)


@app.get("/health")
def health():
    return {"ok": True}

