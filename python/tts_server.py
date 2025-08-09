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
    import collections
    # 🔹 Allow problematic globals so TTS models load without manual hacks
    torch.serialization.add_safe_globals([
        __import__("TTS.utils.radam", fromlist=["RAdam"]).RAdam,
        collections.defaultdict,
        dict
    ])
except Exception:  # pragma: no cover
    torch = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tts_server")

# === Voice & runtime knobs =====================================================
MODEL_ID = os.getenv("TTS_MODEL", "tts_models/en/ek1/tacotron2")
DEFAULT_SPEED = float(os.getenv("TTS_SPEED", "1.12"))
TTS_DEVICE = os.getenv("TTS_DEVICE", "auto").lower()
# ==============================================================================

def _init_tts():
    if CoquiTTS is None:
        return None
    try:
        return CoquiTTS(MODEL_ID)
    except Exception as ex:
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
    except Exception as ex:
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
    "TTS init model=%s device=%s torch=%s cuda_avail=%s cuda_count=%s current_device=%s device_name=%s sr=%s init_ms=%s speed=%.3f",
    MODEL_ID,
    device_used,
    torch_version,
    cuda_avail,
    cuda_count,
    current_device,
    device_name,
    DEFAULT_SR,
    init_ms,
    DEFAULT_SPEED,
)

app = FastAPI()

class SpeakRequest(BaseModel):
    text: str
    sample_rate: int | None = None
    stream: bool | None = False
    speed: float | None = None  # >1.0 = faster

def _apply_speed(wav: np.ndarray, speed: float) -> np.ndarray:
    if speed is None or abs(speed - 1.0) < 1e-3:
        return wav
    speed = max(0.5, min(2.0, float(speed)))
    n = wav.shape[0]
    new_n = max(1, int(n / speed))
    x_old = np.arange(n, dtype=np.float64)
    x_new = np.linspace(0, n - 1, new_n, dtype=np.float64)
    return np.interp(x_new, x_old, wav).astype(np.float32)

def synthesize(text: str, speed: float | None = None) -> np.ndarray:
    if torch is not None:
        with torch.inference_mode():
            if getattr(tts, "device", "cpu") == "cuda":
                try:
                    from torch.amp import autocast
                    autocast_ctx = autocast("cuda")
                except Exception:
                    from torch.cuda.amp import autocast
                    autocast_ctx = autocast()
                with autocast_ctx:
                    y = tts.tts(text)
            else:
                y = tts.tts(text)
    else:
        y = tts.tts(text)
    wav = np.asarray(y, dtype=np.float32)
    if wav.ndim > 1:
        wav = np.mean(wav, axis=1).astype(np.float32)
    thr = 0.0025
    nz = np.where(np.abs(wav) > thr)[0]
    if nz.size > 0:
        wav = wav[nz[0]: nz[-1] + 1]
    eff_speed = speed if speed is not None else DEFAULT_SPEED
    return _apply_speed(wav, eff_speed)

WARMED_UP = False
try:
    warm_start = time.perf_counter()
    synthesize("warmup", speed=DEFAULT_SPEED)
    warmup_ms = int((time.perf_counter() - warm_start) * 1000)
    WARMED_UP = True
    logger.info("TTS warmup_ms=%s", warmup_ms)
except Exception as ex:
    logger.warning("TTS warmup failed: %s", ex)

# … rest of your original /speak, /speak_debug, /health, /env_debug endpoints remain unchanged …
