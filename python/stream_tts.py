"""Stream text-to-speech audio.

This script reads lines of text from stdin. For each line received it
synthesizes speech using Coqui TTS and writes the resulting MP3 bytes to
stdout. The script is intended to be used as a subprocess where the
caller pipes incremental text to stdin and consumes audio from stdout.
"""

import io
import sys

from TTS.api import TTS
from pydub import AudioSegment


tts = TTS(
    model_name="tts_models/en/ljspeech/tacotron2-DDC",
    progress_bar=False,
    gpu=False,
)

for line in sys.stdin:
    text = line.strip()
    if not text:
        continue

    # Generate audio for the current chunk of text
    wav = tts.tts(text)
    audio = AudioSegment(
        wav.tobytes(),
        frame_rate=tts.output_sample_rate,
        sample_width=2,
        channels=1,
    )
    buf = io.BytesIO()
    audio.export(buf, format="mp3")
    sys.stdout.buffer.write(buf.getvalue())
    sys.stdout.flush()
