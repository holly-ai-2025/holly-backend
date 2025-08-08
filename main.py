from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import subprocess
import tempfile
from pathlib import Path
from faster_whisper import WhisperModel
import os

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
    model = WhisperModel("small", device="cuda", compute_type="float16")


class TTSRequest(BaseModel):
    text: str


@app.post("/tts")
def tts_endpoint(req: TTSRequest):
    if not req.text:
        raise HTTPException(status_code=400, detail="Missing text")

    script_path = Path(__file__).resolve().parent / "python" / "tts.py"
    process = subprocess.Popen(
        ["python3", str(script_path), "--stream"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )

    try:
        process.stdin.write(req.text.encode())
        process.stdin.close()
    except Exception:
        process.kill()
        raise HTTPException(status_code=500, detail="Failed to write to TTS process")

    def iter_audio():
        try:
            while True:
                chunk = process.stdout.read(1024)
                if not chunk:
                    break
                yield chunk
            return_code = process.wait()
            if return_code != 0:
                err = process.stderr.read().decode()
                raise HTTPException(status_code=500, detail=err)
        finally:
            process.stdout.close()
            process.stderr.close()

    headers = {
        "Cache-Control": "no-cache",
        "Content-Type": "audio/mpeg",
        "Transfer-Encoding": "chunked",
    }

    return StreamingResponse(iter_audio(), media_type="audio/mpeg", headers=headers)


@app.post("/listen")
async def listen(file: Optional[UploadFile] = File(None)):
    if file is None:
        raise HTTPException(status_code=400, detail="No file provided")

    if model is None:
        raise HTTPException(status_code=500, detail="Model not loaded")

    suffix = Path(file.filename).suffix or ".webm"
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            data = await file.read()
            tmp.write(data)
            tmp_path = tmp.name

        size = len(data)
        segments, _ = model.transcribe(tmp_path)
        text = "".join(segment.text for segment in segments).strip()
        print(f"Transcribed {file.filename} ({size} bytes): {text}")
    except Exception as exc:
        print(f"Transcription failed for {file.filename}: {exc}")
        raise HTTPException(status_code=500, detail="Transcription failed")
    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass

    return {"text": text}


@app.get("/health")
def health():
    return {"status": "ok"}
