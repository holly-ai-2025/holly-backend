from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import subprocess
from pathlib import Path

app = FastAPI()


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
