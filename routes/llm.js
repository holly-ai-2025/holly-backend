const express = require('express');
const cors = require('cors');
const fetch = global.fetch || require('node-fetch');
const { spawn } = require('child_process');
const path = require('path');

const router = express.Router();
router.use(cors());

router.post('/', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Trailer', 'X-Transcript');

  const scriptPath = path.join(__dirname, '..', 'python', 'stream_tts.py');
  const python = spawn('python3', [scriptPath]);

  let closed = false;
  req.on('close', () => {
    closed = true;
    python.kill();
  });

  python.stdout.on('data', (chunk) => {
    res.write(chunk);
  });

  python.stderr.on('data', (data) => {
    console.error('TTS error:', data.toString());
  });

  let textBuffer = '';

  try {
    const response = await fetch('http://localhost:11111/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3',
        prompt: prompt,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      textBuffer += chunk;
      python.stdin.write(chunk + '\n');
    }

    python.stdin.end();

    python.on('close', () => {
      if (!closed) {
        res.addTrailers({ 'X-Transcript': textBuffer });
        res.end();
      }
    });
  } catch (error) {
    console.error('Error querying Llama:', error.message);
    python.kill();
    if (!closed) {
      res.status(500).end();
    }
  }
});

module.exports = router;
