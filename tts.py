"""
Ubuntu packages required for full TTS support:
    sudo apt-get install ffmpeg libavcodec-extra lame
"""

import sys
import os
from TTS.api import TTS
from pydub import AudioSegment

def main():
    text = sys.argv[1] if len(sys.argv) > 1 else "Hello there"
    base_dir = os.path.dirname(os.path.abspath(__file__))
    wav_path = os.path.join(base_dir, 'output.wav')
    mp3_path = os.path.join(base_dir, 'output.mp3')

    tts = TTS(model_name="tts_models/en/ljspeech/tacotron2-DDC", progress_bar=False, gpu=False)
    tts.tts_to_file(text=text, file_path=wav_path)

    audio = AudioSegment.from_wav(wav_path)
    audio.export(mp3_path, format='mp3')

    print(os.path.abspath(mp3_path))

if __name__ == '__main__':
    main()
