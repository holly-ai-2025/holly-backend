const express = require('express');
const fetch = global.fetch || require('node-fetch');
const { spawn } = require('child_process');
const path = require('path');

const router = express.Router();

let currentSession = null;

router.post('/', async (req, res) => {
  const { text, prompt, generate = false, json = false, stream = false } =
    req.body || {};
  console.log('TTS request body', req.body);

  let spoken = text;

  if (!spoken && prompt) {
    if (generate) {
      try {
        console.log('Fetching from Ollama...');
        const r = await fetch('http://localhost:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'llama3', prompt, stream: false })
        });
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(
            `Ollama error: ${r.status} ${r.statusText} body=${body.slice(0,200)}`
          );
        }
        const data = await r.json().catch(() => null);
        spoken =
          data && typeof data.response === 'string' ? data.response : '';
        console.log('LLM text length:', spoken.length);
        if (!spoken) throw new Error('LLM returned empty text');
      } catch (e) {
        console.error('Error contacting Ollama:', e.message);
        return res.status(502).json({ stage: 'ollama', error: e.message });
      }
    } else {
      spoken = prompt;
    }
  }

  if (!spoken) {
    return res.status(400).json({ error: 'Text or prompt is required' });
  }

  if (json) {
    return res.status(200).json({ response: spoken });
  }

  if (currentSession?.abort) {
    try { currentSession.abort(); } catch {}
    currentSession = null;
  }

  let headersSent = false;
  let audioBytes = 0;
  let stderrBuffer = '';
  let closed = false;
  let python = null;

  const cleanup = () => {
    if (currentSession && currentSession.python === python) currentSession = null;
  };

  req.on('close', () => {
    closed = true;
    if (python) {
      try { python.kill(); } catch {}
    }
    cleanup();
  });

  // Python TTS
  try {
    const scriptPath = path.join(__dirname, '..', 'python', 'tts.py');
    console.log('Spawning TTS Python script:', scriptPath, 'stream:', !!stream);
    python = spawn('python3', [scriptPath, '--stream']);

    const isMp3Like = (buf) =>
      buf.slice(0,3).equals(Buffer.from('ID3')) ||
      (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);

    let first = true;
    const chunks = [];

    python.stdout.on('data', (chunk) => {
      if (first) {
        first = false;
        if (!isMp3Like(chunk)) {
          stderrBuffer += 'Invalid MP3 header\n';
          console.error('Invalid MP3 header:', chunk.slice(0,10).toString('hex'));
          try { python.kill(); } catch {}
          if (!headersSent) {
            headersSent = true;
            return res.status(500).json({ stage: 'tts', error: 'Bad MP3 header from Python TTS' });
          }
          return;
        }
        res.status(200).setHeader('Content-Type', 'audio/mpeg');
        if (stream) {
          res.setHeader('Transfer-Encoding', 'chunked');
          res.setHeader('Trailer', 'X-Transcript');
        } else {
          res.setHeader('Content-Disposition', 'inline; filename="tts.mp3"');
        }
        headersSent = true;
      }

      audioBytes += chunk.length;
      if (stream) res.write(chunk);
      else chunks.push(chunk);
    });

    python.stderr.on('data', (d) => {
      const msg = d.toString();
      stderrBuffer += msg;
      console.error('TTS stderr:', msg.trim());
    });

    python.on('close', (code) => {
      cleanup();
      const ok = code === 0 && audioBytes > 0;
      if (!ok) {
        console.error('tts.py exited', { code, audioBytes, stderr: stderrBuffer.slice(0,500) });
        if (!headersSent) {
          return res.status(500).json({
            stage: 'tts',
            error: `TTS failed (code=${code}, bytes=${audioBytes})`,
            stderr: stderrBuffer.slice(0,500)
          });
        }
        return res.end();
      }

      if (stream) {
        res.addTrailers?.({ 'X-Transcript': spoken });
        return res.end();
      } else {
        const buf = Buffer.concat(chunks);
        res.setHeader('Content-Length', String(buf.length));
        res.setHeader('X-Transcript', spoken);
        return res.end(buf);
      }
    });

    python.on('error', (err) => {
      cleanup();
      console.error('Failed to start tts.py:', err.message);
      if (!headersSent) {
        return res.status(500).json({ stage: 'tts', error: err.message });
      }
      res.end();
    });

    currentSession = { python, abort: () => { try { python.kill(); } catch {} } };
    python.stdin.write(spoken);
    python.stdin.end();

  } catch (e) {
    cleanup();
    console.error('Error in TTS stage:', e.message);
    if (!headersSent) {
      return res.status(500).json({ stage: 'tts', error: e.message });
    }
    res.end();
  }
});

module.exports = router;
