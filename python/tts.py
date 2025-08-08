#!/usr/bin/env python3
import sys
import os
import argparse
import json
import numpy as np
import subprocess
import threading

# Avoid broken pipe crashes if client disconnects
try:
    import signal
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
except Exception:
    pass

def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)

def synthesize_text(text: str):
    """
    Return (wav_f32_mono, sample_rate).
    Uses Coqui TTS offline model by default.
    """
    model_id = os.environ.get("TTS_MODEL", "tts_models/en/ljspeech/tacotron2-DDC")
    eprint(f"[tts.py] loading model {model_id}")
    try:
        from TTS.api import TTS  # Coqui TTS
    except Exception as ex:
        eprint(json.dumps({"error": f"Coqui TTS not installed: {ex}"}))
        sys.exit(1)

    try:
        tts = TTS(model_id)
        wav = tts.tts(text)
        # Coqui returns float32 PCM [-1, 1]
        sr = getattr(tts, "output_sample_rate", None) or getattr(tts, "sample_rate", 22050)
        wav = np.asarray(wav, dtype=np.float32)
        if wav.ndim > 1:
            wav = np.mean(wav, axis=1).astype(np.float32)
        return wav, int(sr)
    except Exception as ex:
        eprint(json.dumps({"error": f"TTS synthesis failed: {ex}"}))
        sys.exit(1)

def float_to_int16_bytes(wav_f32: np.ndarray) -> bytes:
    wav = np.clip(wav_f32, -1.0, 1.0)
    wav_i16 = (wav * 32767.0).astype(np.int16)
    return wav_i16.tobytes()

def start_ffmpeg_encoder(in_sr: int):
    """
    Launch ffmpeg to read 16-bit mono PCM on stdin and write MP3 on stdout.
    """
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-f", "s16le",
        "-ar", str(in_sr),
        "-ac", "1",
        "-i", "pipe:0",
        # Output MP3
        "-f", "mp3",
        "-b:a", os.environ.get("TTS_MP3_BITRATE", "128k"),
        "-ar", os.environ.get("TTS_MP3_RATE", "22050"),
        "pipe:1",
    ]
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        return proc
    except FileNotFoundError:
        eprint(json.dumps({"error": "ffmpeg not found. Install with: apt-get update && apt-get install -y ffmpeg"}))
        sys.exit(1)

def write_stdout_streaming(ffmpeg_proc, chunk_size=16384):
    """
    Relay ffmpeg stdout to our stdout (binary) in chunks for streaming.
    """
    out = ffmpeg_proc.stdout
    dest = sys.stdout.buffer
    try:
        while True:
            chunk = out.read(chunk_size)
            if not chunk:
                break
            dest.write(chunk)
            dest.flush()
    except BrokenPipeError:
        # Client went away; just stop
        pass
    except Exception as ex:
        eprint(json.dumps({"error": f"stdout relay error: {ex}"}))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stream", action="store_true", help="stream MP3 to stdout in chunks")
    args = parser.parse_args()

    # Read the entire prompt from stdin (Node writes it)
    try:
        text = sys.stdin.read()
    except Exception as ex:
        eprint(json.dumps({"error": f"stdin read failed: {ex}"}))
        sys.exit(1)

    text = (text or "").strip()
    if not text:
        text = "Hello. This is a test of the Holly text to speech system."

    # Synthesize to float32 PCM
    wav_f32, sr = synthesize_text(text)
    pcm_bytes = float_to_int16_bytes(wav_f32)

    # Encode MP3 via ffmpeg
    proc = start_ffmpeg_encoder(sr)

    # STREAMING: relay ffmpeg stdout while feeding stdin
    if args.stream:
        # Start a reader thread to relay encoded MP3 to client as it is produced
        relay_thread = threading.Thread(target=write_stdout_streaming, args=(proc,))
        relay_thread.daemon = True
        relay_thread.start()

        try:
            # Write PCM to ffmpeg in chunks
            stdin = proc.stdin
            mv = memoryview(pcm_bytes)
            step = 16384
            for i in range(0, len(mv), step):
                part = mv[i:i+step]
                stdin.write(part)
            stdin.close()
        except BrokenPipeError:
            # Client gone or encoder failed
            pass
        except Exception as ex:
            eprint(json.dumps({"error": f"ffmpeg stdin write error: {ex}"}))
        finally:
            proc.wait()
            relay_thread.join()

        # Exit with ffmpeg's code so the caller can detect failure if needed
        sys.exit(proc.returncode or 0)

    # NON-STREAMING: feed all PCM, collect all MP3, then write once
    try:
        out, err = proc.communicate(input=pcm_bytes)
    except Exception as ex:
        eprint(json.dumps({"error": f"ffmpeg communicate error: {ex}"}))
        sys.exit(1)

    if proc.returncode != 0 or not out:
        eprint(err.decode("utf-8", errors="ignore"))
        eprint(json.dumps({"error": f"ffmpeg failed (code={proc.returncode})"}))
        sys.exit(1)

    try:
        sys.stdout.buffer.write(out)
        sys.stdout.buffer.flush()
    except BrokenPipeError:
        pass

if __name__ == "__main__":
    main()
