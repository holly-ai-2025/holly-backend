const express = require('express');
const cors = require('cors');
const fetch = global.fetch || require('node-fetch');
const { spawn } = require('child_process');
const path = require('path');

const router = express.Router();
router.use(cors());

// Global controller to ensure only one active TTS session
let currentSession = null;

router.post('/', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // stop any existing session
  if (currentSession) {
    currentSession.abort();
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Trailer', 'X-Transcript');

  const scriptPath = path.join(__dirname, '..', 'python', 'stream_tts.py');
  const python = spawn('python3', [scriptPath]);

  const abortController = new AbortController();
  let closed = false;

  const cleanup = () => {
    if (currentSession && currentSession.python === python) {
      currentSession = null;
    }
  };

  req.on('close', () => {
    closed = true;
    abortController.abort();
    python.kill();
    cleanup();
  });

  python.stdout.on('data', (chunk) => {
    res.write(chunk);
  });

  python.stderr.on('data', (data) => {
    console.error('TTS error:', data.toString());
  });

  let textBuffer = '';

  // allow controller to abort
  currentSession = {
    python,
    abort: () => {
      abortController.abort();
      python.kill();
    },
  };

  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3',
        prompt,
        stream: true,
      }),
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    for await (const chunk of response.body) {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          continue;
        }
        if (parsed.response) {
          textBuffer += parsed.response;
          python.stdin.write(parsed.response + '\n');
        }
      }
    }

    python.stdin.end();

    python.on('close', () => {
      cleanup();
      if (!closed) {
        res.addTrailers({ 'X-Transcript': textBuffer });
        res.end();
      }
    });
  } catch (error) {
    cleanup();
    console.error('Error querying Llama:', error.message);
    python.kill();
    if (!closed) {
      res.status(500).end();
    }
  }
});

module.exports = router;
