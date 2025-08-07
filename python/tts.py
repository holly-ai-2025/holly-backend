"""Text-to-Speech generation using Coqui TTS.

Ubuntu package requirements::

    sudo apt-get update && sudo apt-get install -y ffmpeg libavcodec-extra lame

Python package requirements::

    pip install TTS pydub

This script can either stream the generated audio directly to stdout or
write an MP3 file to disk. By default it writes to a temporary file and
prints the absolute file path. Pass ``--stream`` to emit ``audio/mpeg``
data on stdout for real-time playback.
"""

import argparse
import json
import os
import sys
import tempfile
import uuid

import numpy as np
from TTS.api import TTS
from pydub import AudioSegment


MODEL_NAME = os.getenv("TTS_MODEL", "tts_models/en/ljspeech/tacotron2-DDC")


def load_model() -> TTS:
    """Load and return the TTS model, logging any issues."""

    try:
        sys.stderr.write(f"[tts.py] loading model {MODEL_NAME}\n")
        tts = TTS(model_name=MODEL_NAME, progress_bar=False, gpu=False)
        sys.stderr.write("[tts.py] model loaded\n")
        return tts
    except Exception as exc:
        sys.stderr.write(f"[tts.py] model load error: {exc}\n")
        raise



def synthesize(tts: TTS, text: str, stream: bool) -> None:
    """Generate speech from *text* and either stream or save to disk."""

    sys.stderr.write(
        f"[tts.py] starting synthesis stream={stream} text_length={len(text)}\n"
    )

    try:
        if stream:
            audio = np.array(tts.tts(text))
            if audio.size == 0:
                raise RuntimeError("no audio generated")
            sample_rate = getattr(tts, "sample_rate", 22050)
            if audio.dtype != np.int16:
                audio = (audio * (2 ** 15 - 1)).astype(np.int16)
            sys.stderr.write(
                f"[tts.py] streaming {len(audio)} samples at {sample_rate}Hz\n"
            )
            segment = AudioSegment(
                audio.tobytes(),
                frame_rate=sample_rate,
                sample_width=audio.dtype.itemsize,
                channels=1,
            )
            stdout = os.fdopen(sys.stdout.fileno(), "wb", buffering=0)
            segment.export(
                stdout,
                format="mp3",
                parameters=[
                    "-codec:a",
                    "libmp3lame",
                    "-b:a",
                    "192k",
                    "-flush_packets",
                    "1",
                    "-fflags",
                    "+nobuffer",
                ],
            )
            stdout.flush()
            sys.stderr.write("[tts.py] streaming complete\n")
        else:
            tmpdir = tempfile.gettempdir()
            uid = uuid.uuid4().hex
            wav_path = os.path.join(tmpdir, f"{uid}.wav")
            mp3_path = os.path.join(tmpdir, f"{uid}.mp3")
            tts.tts_to_file(text=text, file_path=wav_path)
            if not os.path.exists(wav_path) or os.path.getsize(wav_path) == 0:
                raise RuntimeError("no audio generated")
            AudioSegment.from_wav(wav_path).export(mp3_path, format="mp3")
            os.remove(wav_path)
            print(mp3_path)
            sys.stderr.write(f"[tts.py] wrote MP3 to {mp3_path}\n")
    except Exception as exc:
        sys.stderr.write(f"[tts.py] inference error: {exc}\n")
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Coqui TTS utility")
    parser.add_argument("text", nargs="?", help="Text to synthesize. Reads from stdin if omitted")
    parser.add_argument("--stream", action="store_true", help="Stream MP3 data to stdout")
    args = parser.parse_args()

    input_text = args.text if args.text else sys.stdin.read().strip()
    try:
        tts = load_model()
        synthesize(tts, input_text, args.stream)
    except Exception as exc:
        error = {"error": str(exc)}
        sys.stdout.write(json.dumps(error) + "\n")
        sys.exit(1)


if __name__ == "__main__":
    main()

