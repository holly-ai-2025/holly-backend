// routes/tts.js
const express = require('express');
const cors = require('cors');
const fetch = global.fetch || require('node-fetch');
const { spawn } = require('child_process');
const path = require('path');

const router = express.Router();
// CORS here is fine; you also have global CORS in server.js
router.use(cors());

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

// Track the current synthesis so we can cancel it on a new request
let currentSession = null;

router.post('/', async (req, res) => {
  const { prompt, json = false, stream = false } = req.body || {};
  console.log('TTS request body', req.body);

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // Cancel any in-flight synth (don’t abort the Ollama fetch; we haven’t started it yet)
  if (currentSession?.abort) {
    try { currentSession.abort(); } catch {}
    currentSession = null;
  }

  // 1) Get text from Ollama (non-streaming for reliability)
  let text = '';
  try {
    console.log('Fetching from Ollama (stream:false)…', OLLAMA_URL);
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', prompt, stream: false })
    });

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('Ollama non-OK:', r.status, r.statusText, body.slice(0,200));
      return res.status(502).json({ error: `Upstream LLM ${r.status} ${r.statusText}` });
    }

    const data = await r.json().catch(err => {
      console.error('Ollama parse error:', err);
      return null;
    });

    text = (data && typeof data.response === 'string') ? data.response.trim() : '';
    console.log('LLM text length:', text.length);
  } catch (e) {
    console.error('Error contacting Ollama:', e.message);
    return res.status(502).json({ error: 'Upstream LLM error' });
  }

  if (!text) {
    return res.status(502).json({ error: 'LLM returned empty response' });
  }

  // Debug/diagnostic mode: just return text
  if (json) {
    return res.status(200).json({ response: text });
  }

  // 2) Synthesize speech via python/tts.py
  let headersSent = false;
  let audioBytes = 0;
  let stderrBuffer = '';
  let python = null;
  let closed = false;

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

  try {
    const scriptPath = path.join(__dirname, '..', 'python', 'tts.py');
    console.log('Spawning tts.py at', scriptPath, ' stream:', !!stream);
    python = spawn('python3', [scriptPath, '--stream']);

    const isMp3Like = (buf) =>
      buf && buf.length >= 2 && (
        buf.slice(0,3).equals(Buffer.from('ID3')) ||
        (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
      );

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
