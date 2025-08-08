import io
import wave
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
import numpy as np

app = FastAPI()

class SpeakRequest(BaseModel):
    text: str
    sample_rate: int | None = None

def synthesize(text: str, sr: int) -> np.ndarray:
    """Return a float32 waveform. Placeholder sine tone."""
    duration = 0.5  # seconds
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    # simple 440 Hz sine wave as placeholder
    wav = 0.2 * np.sin(2 * np.pi * 440 * t)
    return wav.astype(np.float32)

def wav_bytes_from_float32(wav_f32: np.ndarray, sr: int) -> bytes:
    wav_f32 = np.clip(wav_f32, -1.0, 1.0)
    pcm16 = (wav_f32 * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sr)
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()

@app.post("/speak")
def speak(req: SpeakRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    sr = req.sample_rate or 22050
    wav_f32 = synthesize(text, sr)
    wav_bytes = wav_bytes_from_float32(wav_f32, sr)
    headers = {
        "Content-Type": "audio/wav",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "Content-Length": str(len(wav_bytes)),
    }
    return Response(content=wav_bytes, media_type="audio/wav", headers=headers)

@app.get("/health")
def health():
    return {"ok": True}
