// routes/tts.js
const express = require('express');
const cors = require('cors');
const fetch = global.fetch || require('node-fetch');
const { spawn } = require('child_process');
const path = require('path');

const router = express.Router();
router.use(cors());

// track 1 in-flight TTS session so a new request cancels the old one
let currentSession = null;

router.post('/', async (req, res) => {
  // default to streaming MP3; allow ?json=true to return transcript only
  const { prompt, stream = true, json = false } = req.body || {};

  console.log('TTS request body', req.body);
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // abort any in-flight session
  if (currentSession?.abort) {
    try { currentSession.abort(); } catch {}
    currentSession = null;
  }

  const abortController = new AbortController();
  const scriptPath = path.join(__dirname, '..', 'python', 'tts.py');

  let closed = false;
  let python = null;
  let headersSent = false;
  let stderrBuffer = '';
  let audioBytes = 0;
  const chunks = [];
  let textBuffer = '';

  const cleanup = () => {
    if (currentSession?.python === python) currentSession = null;
  };

  req.on('close', () => {
    closed = true;
    abortController.abort();
    try { python?.kill(); } catch {}
    cleanup();
  });

  try {
    // 1) Get LLM answer as text (NDJSON stream from Ollama)
    const llamaResp = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // request streaming so we can accumulate incrementally
      body: JSON.stringify({ model: 'llama3', prompt, stream: true }),
      signal: abortController.signal,
    });

    if (!llamaResp.ok) {
      throw new Error(`LLM HTTP ${llamaResp.status}`);
    }

    if (llamaResp.body && (llamaResp.headers.get('content-type') || '').includes('application/x-ndjson')) {
      for await (const chunk of llamaResp.body) {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.response) textBuffer += obj.response;
          } catch { /* ignore partial lines */ }
        }
      }
    } else {
      // fallback if server responded plain JSON or text
      try {
        const data = await llamaResp.json();
        if (data?.response) textBuffer = data.response;
      } catch {
        const txt = await llamaResp.text();
        if (txt) textBuffer += txt;
      }
    }

    console.log('LLM response length for TTS', textBuffer.length);

    // debugging mode: just return text
    if (json) {
      cleanup();
      return res.status(200).json({ response: textBuffer });
    }

    // 2) Spawn python TTS and stream MP3
    console.log('Spawning tts.py at', scriptPath);
    python = spawn('python3', [scriptPath, '--stream'], { stdio: ['pipe', 'pipe', 'pipe'] });

    const isProbablyMp3 = (buf) =>
      buf.slice(0, 3).equals(Buffer.from('ID3')) ||
      (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);

    let firstChunk = true;

    python.stdout.on('data', (chunk) => {
      if (firstChunk) {
        console.log('First TTS chunk received', {
          length: chunk.length,
          firstBytes: chunk.slice(0, 10).toString('hex'),
        });

        if (!isProbablyMp3(chunk)) {
          stderrBuffer += 'Invalid MP3 header\n';
          console.error('Invalid MP3 header', chunk.slice(0, 10).toString('hex'));
          try { python.kill(); } catch {}
          return;
        }

        // Only set headers once we know it's audio
        res.status(200);
        res.setHeader('Content-Type', 'audio/mpeg');
        if (stream) {
          res.setHeader('Transfer-Encoding', 'chunked');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('Trailer', 'X-Transcript');
        }
        headersSent = true;
        firstChunk = false;
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
      if (closed) return;

      const success = audioBytes > 0 && code === 0;
      if (!success) {
        console.error('tts.py exited with code', code, { headersSent, audioBytes, stderr: stderrBuffer });
        if (!headersSent) return res.status(500).json({ error: 'TTS generation failed' });
        return res.end();
      }

      if (stream) {
        // add trailer with transcript
        res.addTrailers?.({ 'X-Transcript': textBuffer });
        return res.end();
      } else {
        const audioBuffer = Buffer.concat(chunks);
        res.status(200);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', String(audioBuffer.length));
        res.setHeader('X-Transcript', textBuffer);
        return res.end(audioBuffer);
      }
    });

    python.on('error', (err) => {
      cleanup();
      console.error('Failed to start tts.py:', err.message);
      if (closed) return;
      if (headersSent) res.end();
      else res.status(500).json({ error: 'TTS process error' });
    });

    // allow controller to abort
    currentSession = {
      python,
      abort: () => {
        abortController.abort();
        try { python.kill(); } catch {}
      },
    };

    // send text to TTS stdin
    console.log('Sending text to tts.py for synthesis');
    python.stdin.write(textBuffer);
    python.stdin.end();
  } catch (err) {
    cleanup();
    console.error('Error in /tts:', err?.message || err);
    if (!headersSent && !closed) {
      return res.status(500).json({ error: 'Failed to generate speech' });
    }
  }
});

module.exports = router;
