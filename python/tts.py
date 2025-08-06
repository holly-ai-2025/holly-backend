"""
Text-to-Speech generation using Coqui TTS.

Dependencies for Ubuntu:
    sudo apt-get update && sudo apt-get install -y ffmpeg
    pip install TTS pydub

This script accepts text as a command-line argument, synthesizes speech
using a high quality neural voice model, and writes the result to a
temporary MP3 file. The absolute path to the MP3 file is printed to
stdout so that calling processes can stream or download the audio.
"""

import os
import sys
import uuid
import tempfile

from TTS.api import TTS
from pydub import AudioSegment


def main() -> None:
    text = sys.argv[1] if len(sys.argv) > 1 else "Hello world"

    tmpdir = tempfile.gettempdir()
    uid = uuid.uuid4().hex
    wav_path = os.path.join(tmpdir, f"{uid}.wav")
    mp3_path = os.path.join(tmpdir, f"{uid}.mp3")

    tts = TTS(
        model_name="tts_models/en/ljspeech/tacotron2-DDC",
        progress_bar=False,
        gpu=False,
    )
    tts.tts_to_file(text=text, file_path=wav_path)

    AudioSegment.from_wav(wav_path).export(mp3_path, format="mp3")
    os.remove(wav_path)

    print(mp3_path)


if __name__ == "__main__":
    main()

