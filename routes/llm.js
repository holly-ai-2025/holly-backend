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
  const { prompt, stream = true } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // stop any existing session
  if (currentSession) {
    currentSession.abort();
  }

  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Connection': 'keep-alive',
    'Trailer': 'X-Transcript',
  });

  const scriptPath = path.join(__dirname, '..', 'python', 'tts.py');
  const abortController = new AbortController();
  let closed = false;
  let python = null;

  const cleanup = () => {
    if (currentSession && python && currentSession.python === python) {
      currentSession = null;
    }
  };

  req.on('close', () => {
    closed = true;
    abortController.abort();
    if (python) {
      python.kill();
    }
    cleanup();
  });

  let textBuffer = '';

  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3',
        prompt,
        stream,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    if (stream && response.body) {
      for await (const chunk of response.body) {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.response) {
              textBuffer += parsed.response;
            }
          } catch {
            continue;
          }
        }
      }
    } else {
      const data = await response.json();
      textBuffer = data.response || '';
    }

    python = spawn('python3', [scriptPath, '--stream']);

    python.stdout.on('data', (chunk) => {
      res.write(chunk);
    });

    python.stderr.on('data', (data) => {
      console.error('TTS error:', data.toString());
    });

    python.on('close', () => {
      cleanup();
      if (!closed) {
        res.addTrailers({ 'X-Transcript': textBuffer });
        res.end();
      }
    });

    // allow controller to abort
    currentSession = {
      python,
      abort: () => {
        abortController.abort();
        python.kill();
      },
    };

    python.stdin.write(textBuffer);
    python.stdin.end();
  } catch (error) {
    cleanup();
    console.error('Error querying Llama:', error.message);
    if (python) {
      python.kill();
    }
    if (!closed) {
      res.status(500).end();
    }
  }
});

module.exports = router;
