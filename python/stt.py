import os
import logging
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
import torch

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("stt")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

model: Optional[WhisperModel] = None


@app.on_event("startup")
def load_model() -> None:
    global model
    use_gpu = torch.cuda.is_available()
    device = "cuda" if use_gpu else "cpu"
    compute_type = "float16" if use_gpu else "int8"
    try:
        model = WhisperModel("medium.en", device=device, compute_type=compute_type)
        if use_gpu:
            logger.info("✅ Whisper STT running on GPU")
        else:
            logger.warning("⚠️ Falling back to CPU")
    except Exception as exc:  # pragma: no cover
        logger.warning("Model load failed on %s: %s", device, exc)
        model = WhisperModel("medium.en", device="cpu")
        logger.warning("⚠️ Falling back to CPU")


@app.post("/listen")
async def listen(file: UploadFile = File(...)):
    if model is None:
        raise HTTPException(status_code=500, detail="Model not loaded")
    if not file:
        raise HTTPException(status_code=400, detail="No file provided")

    suffix = Path(file.filename or "").suffix or ".webm"
    try:
        data = await file.read()
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        segments, _ = model.transcribe(tmp_path)
        text = "".join(seg.text for seg in segments).strip()
    except Exception as exc:
        logger.exception("Transcription failed: %s", exc)
        raise HTTPException(status_code=500, detail="Transcription failed")
    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
    return {"text": text}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
