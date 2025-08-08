const express = require('express');
const cors = require('cors');
const fetch = global.fetch || require('node-fetch');
const { spawn } = require('child_process');
const path = require('path');

const router = express.Router();
router.use(cors());

let currentSession = null;

router.post('/', async (req, res) => {
  const { prompt, json = false, stream = false } = req.body || {};
  console.log('TTS request body', req.body);

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // Cancel any in-flight synth
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
    // only kill Python if we started audio (avoid aborting the Ollama fetch mid-flight)
    if (python) {
      try { python.kill(); } catch {}
    }
    cleanup();
  });

  // 1) Get text from Ollama (non-streaming for reliability)
  let text = '';
  try {
    console.log('Fetching from Ollama (stream:false)…');
    const r = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', prompt, stream: false })
    });

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Ollama ${r.status} ${r.statusText} body=${body.slice(0,200)}`);
    }

    const data = await r.json().catch(() => null);
    text = (data && typeof data.response === 'string') ? data.response : '';
    console.log('LLM text length:', text.length);
  } catch (e) {
    console.error('Error contacting Ollama:', e.message);
    return res.status(502).json({ error: 'Upstream LLM error' });
  }

  if (json) {
    return res.status(200).json({ response: text });
  }

  // 2) Synthesize speech via python/tts.py
  try {
    const scriptPath = path.join(__dirname, '..', 'python', 'tts.py');
    console.log('Spawning tts.py at', scriptPath, ' stream:', !!stream);
    python = spawn('python3', [scriptPath, '--stream']);

    const isMp3Like = (buf) =>
      buf.slice(0,3).equals(Buffer.from('ID3')) ||
      (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);

    let first = true;
    const chunks = [];

    python.stdout.on('data', (chunk) => {
      if (first) {
        first = false;
        // Validate first audio bytes before sending headers
        if (!isMp3Like(chunk)) {
          stderrBuffer += 'Invalid MP3 header\n';
          console.error('Invalid MP3 header:', chunk.slice(0,10).toString('hex'));
          try { python.kill(); } catch {}
          if (!headersSent) {
            headersSent = true;
            return res.status(500).json({ error: 'TTS generation failed (bad audio header)' });
          }
          return;
        }

        res.status(200);
        res.setHeader('Content-Type', 'audio/mpeg');
        if (stream) {
          res.setHeader('Transfer-Encoding', 'chunked');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('Trailer', 'X-Transcript');
        } else {
          res.setHeader('Content-Disposition', 'inline; filename="tts.mp3"');
        }
        headersSent = true;
      }

      audioBytes += chunk.length;
      if (stream) {
        res.write(chunk);
      } else {
        chunks.push(chunk);
      }
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
        if (!headersSent) return res.status(500).json({ error: 'TTS generation failed' });
        return res.end();
      }

      if (stream) {
        res.addTrailers?.({ 'X-Transcript': text });
        return res.end();
      } else {
        const buf = Buffer.concat(chunks);
        res.setHeader('Content-Length', String(buf.length));
        res.setHeader('X-Transcript', text);
        return res.end(buf);
      }
    });

    python.on('error', (err) => {
      cleanup();
      console.error('Failed to start tts.py:', err.message);
      if (!headersSent) return res.status(500).json({ error: 'TTS process error' });
      res.end();
    });

    currentSession = {
      python,
      abort: () => { try { python.kill(); } catch {} }
    };

    // Send text for TTS
    python.stdin.write(text);
    python.stdin.end();
  } catch (e) {
    cleanup();
    console.error('Error in TTS stage:', e.message);
    if (!headersSent) return res.status(500).json({ error: 'Failed to generate speech' });
    res.end();
  }
});

module.exports = router;

