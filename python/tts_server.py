import io
import wave
import logging
import os
import time
import asyncio
import struct
import re
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, JSONResponse, StreamingResponse
from pydantic import BaseModel
import numpy as np

try:  # Optional heavy dependency
    from TTS.api import TTS as CoquiTTS  # type: ignore
except Exception:  # pragma: no cover
    CoquiTTS = None

try:  # torch is optional
    import torch
except Exception:  # pragma: no cover
    torch = None


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tts_server")

MODEL_ID = os.getenv("TTS_MODEL", "tts_models/en/ljspeech/tacotron2-DDC")
TTS_DEVICE = os.getenv("TTS_DEVICE", "auto").lower()


def _init_tts():
    if CoquiTTS is None:
        return None
    try:
        return CoquiTTS(MODEL_ID)
    except Exception as ex:  # pragma: no cover
        logger.warning("TTS init failed: %s", ex)
        return None


init_start = time.perf_counter()
tts = _init_tts()
init_ms = int((time.perf_counter() - init_start) * 1000)

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

want_cuda = TTS_DEVICE in ("auto", "cuda")
cuda_avail = bool(torch and torch.cuda.is_available())
device_used = "cpu"
if want_cuda and cuda_avail and hasattr(tts, "to"):
    try:
        tts.to("cuda")
        device_used = "cuda"
    except Exception as ex:  # pragma: no cover
        logger.warning("Could not move TTS to CUDA: %s", ex)
elif TTS_DEVICE == "cuda" and not cuda_avail:
    logger.warning("CUDA requested but unavailable, using CPU")
tts.device = device_used

DEFAULT_SR = int(getattr(tts, "output_sample_rate", getattr(tts, "sample_rate", 22050)))

torch_version = getattr(torch, "__version__", "none")
cuda_count = torch.cuda.device_count() if cuda_avail and torch else 0
current_device = torch.cuda.current_device() if cuda_avail and torch else None
device_name = (
    torch.cuda.get_device_name(current_device) if cuda_avail and torch else None
)

logger.info(
    "TTS init model=%s device=%s torch=%s cuda_avail=%s cuda_count=%s current_device=%s device_name=%s sr=%s init_ms=%s",
    MODEL_ID,
    device_used,
    torch_version,
    cuda_avail,
    cuda_count,
    current_device,
    device_name,
    DEFAULT_SR,
    init_ms,
)


app = FastAPI()


class SpeakRequest(BaseModel):
    """Request payload for /speak.

    Setting ``stream`` to ``True`` enables chunked audio output which starts
    sending a WAV header followed by PCM data as soon as each text chunk is
    synthesized.  When omitted or ``False`` the entire WAV is returned once
    synthesis completes, preserving the legacy behaviour.
    """

    text: str
    sample_rate: int | None = None
    stream: bool | None = False


def synthesize(text: str) -> np.ndarray:
    if torch is not None:
        with torch.inference_mode():
            if getattr(tts, "device", "cpu") == "cuda":
                try:
                    from torch.cuda.amp import autocast

                    with autocast():
                        y = tts.tts(text)
                except Exception as ex:  # pragma: no cover
                    logger.warning("AMP disabled due to error: %s", ex)
                    y = tts.tts(text)
            else:
                y = tts.tts(text)
    else:
        y = tts.tts(text)

    wav = np.asarray(y, dtype=np.float32)
    if wav.ndim > 1:
        wav = np.mean(wav, axis=1).astype(np.float32)
    return wav


WARMED_UP = False
try:
    warm_start = time.perf_counter()
    synthesize("warmup")
    warmup_ms = int((time.perf_counter() - warm_start) * 1000)
    WARMED_UP = True
    logger.info("TTS warmup_ms=%s", warmup_ms)
except Exception as ex:  # pragma: no cover
    logger.warning("TTS warmup failed: %s", ex)


def float32_to_wav_bytes(wav_f32: np.ndarray, sr: int) -> tuple[bytes, int]:
    pcm = (np.clip(wav_f32, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    bio = io.BytesIO()
    with wave.open(bio, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm)
    return bio.getvalue(), len(pcm)


def float32_to_pcm_bytes(wav_f32: np.ndarray) -> bytes:
    return (np.clip(wav_f32, -1.0, 1.0) * 32767).astype(np.int16).tobytes()


def make_wav_header(data_len: int, sample_rate: int = 24000,
                    channels: int = 1, bits_per_sample: int = 16) -> bytes:
    """Return a standard 44-byte PCM WAV header for this chunk."""
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    riff_chunk_size = 36 + data_len
    return (
        b"RIFF" +
        struct.pack("<I", riff_chunk_size) +
        b"WAVE" +
        b"fmt " +
        struct.pack("<IHHIIHH",
                    16,        # Subchunk1Size (PCM)
                    1,         # AudioFormat = PCM
                    channels,
                    sample_rate,
                    byte_rate,
                    block_align,
                    bits_per_sample) +
        b"data" +
        struct.pack("<I", data_len)
    )


async def synthesize_chunk_to_pcm(text: str, sample_rate: int = DEFAULT_SR) -> tuple[bytes, int]:
    wav = await asyncio.to_thread(synthesize, text)
    pcm = float32_to_pcm_bytes(wav)
    return pcm, sample_rate


def chunk_text(text: str, limit: int = 200) -> list[str]:
    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        if current and len(current) + len(sentence) + 1 > limit:
            chunks.append(current.strip())
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current.strip():
        chunks.append(current.strip())
    return chunks


@app.post("/speak")
def speak(req: SpeakRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    sr = int(req.sample_rate or DEFAULT_SR)
    long_text = len(text) > 320
    if long_text:
        logger.info("long_text chars=%s", len(text))
    stream = bool(req.stream)
    try:
        if stream:
            chunks = chunk_text(text)
            logger.info("streaming chunks=%s", len(chunks))

            async def gen():
                for part in chunks:
                    synth_start = time.perf_counter()
                    pcm, sr_used = await synthesize_chunk_to_pcm(part, sr)
                    synth_ms = int((time.perf_counter() - synth_start) * 1000)
                    logger.info("chunk_synth_ms=%s device=%s", synth_ms, tts.device)
                    header = make_wav_header(len(pcm), sample_rate=sr_used,
                                              channels=1, bits_per_sample=16)
                    frame = header + pcm
                    yield struct.pack(">I", len(frame))
                    yield frame
                    await asyncio.sleep(0)

            return StreamingResponse(
                gen(),
                media_type="application/octet-stream",
                headers={
                    "Cache-Control": "no-store",
                    "X-Stream-Framing": "wav-l32be",
                },
            )

        synth_start = time.perf_counter()
        wav = synthesize(text)
        synth_ms = int((time.perf_counter() - synth_start) * 1000)
        data, _ = float32_to_wav_bytes(wav, sr)
        logger.info("synth_ms=%s device=%s", synth_ms, tts.device)
        return Response(
            content=data, media_type="audio/wav", headers={"Cache-Control": "no-store"}
        )
    except Exception as ex:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(ex))


@app.post("/speak_debug")
def speak_debug(req: SpeakRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    sr = int(req.sample_rate or DEFAULT_SR)
    long_text = len(text) > 320
    if long_text:
        logger.info("long_text chars=%s", len(text))
    try:
        synth_start = time.perf_counter()
        wav = synthesize(text)
        synth_ms = int((time.perf_counter() - synth_start) * 1000)
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
            "device_used": tts.device,
            "warmup_done": WARMED_UP,
            "synth_ms": synth_ms,
            "long_text": long_text,
        }
        if warn:
            resp["warning"] = warn
        return resp
    except Exception as ex:
        return JSONResponse({"ok": False, "error": str(ex)}, status_code=500)


@app.get("/health")
def health():
    return {
        "ok": True,
        "device": tts.device,
        "model": MODEL_ID,
        "sample_rate": DEFAULT_SR,
        "torch_version": torch_version,
        "cuda_available": cuda_avail,
    }


@app.get("/env_debug")
def env_debug():
    return {
        "torch_version": torch_version,
        "cuda_available": cuda_avail,
        "cuda_device_count": cuda_count,
        "current_device": current_device,
        "device_name": device_name,
        "device_used": tts.device,
    }

