import os
import logging
import tempfile
from pathlib import Path
from typing import Optional, Dict

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
import torch
import uvicorn

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("stt")

app = FastAPI()

# ---- CORS (explicit origins; "*" + credentials breaks browsers) ----
ALLOWED_ORIGINS = [
    "http://localhost:5173",     # Vite dev
    "http://localhost:3000",     # alt dev
    "https://hollyai.xyz",       # site
    "https://api.hollyai.xyz",   # api if it calls STT
    "https://stt.hollyai.xyz",   # direct STT
]
# Allow override via env (comma-separated)
env_origins = os.getenv("CORS_ALLOW_ORIGINS")
if env_origins:
    ALLOWED_ORIGINS = [o.strip() for o in env_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- Whisper model ----
model: Optional[WhisperModel] = None

@app.on_event("startup")
def load_model() -> None:
    """Load Whisper, prefer GPU; fall back to CPU."""
    global model
    use_gpu = torch.cuda.is_available()
    device = "cuda" if use_gpu else "cpu"
    compute_type = "float16" if use_gpu else "int8"

    model_name = os.getenv("WHISPER_MODEL", "medium.en")
    logger.info("Loading Whisper model '%s' on %s (%s)...", model_name, device, compute_type)

    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        if use_gpu:
            logger.info("✅ Whisper STT running on GPU")
        else:
            logger.warning("⚠️ Whisper STT running on CPU")
    except Exception as exc:
        logger.warning("Model load failed on %s (%s): %s", device, compute_type, exc)
        logger.warning("Falling back to CPU (int8)")
        model = WhisperModel(model_name, device="cpu", compute_type="int8")

@app.post("/listen")
async def listen(file: UploadFile = File(...)) -> Dict[str, str]:
    if model is None:
        raise HTTPException(status_code=500, detail="Model not loaded")
    if not file:
        raise HTTPException(status_code=400, detail="No file provided")

    suffix = Path((file.filename or "")).suffix or ".webm"
    tmp_path = None

    try:
        data = await file.read()
        size = len(data)
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        logger.info("Transcribing %s (%s bytes) -> %s", file.filename, size, tmp_path)
        segments, info = model.transcribe(tmp_path)
        text = "".join(seg.text for seg in segments).strip() or ""
        logger.info("Transcription done: %r", text)
        return {"text": text}

    except Exception as exc:
        logger.exception("Transcription failed for %s: %s", getattr(file, "filename", "<no-name>"), exc)
        raise HTTPException(status_code=500, detail="Transcription failed")

    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except Exception:
                pass

@app.get("/health")
def health() -> Dict[str, str]:
    mode = "gpu" if torch.cuda.is_available() else "cpu"
    return {"status": "ok", "mode": mode}

if __name__ == "__main__":
    # Default to 8001 to match your PM2/cloudflared routing; override via PORT env if needed.
    port = int(os.getenv("PORT", "8001"))
    uvicorn.run(app, host="0.0.0.0", port=port)
