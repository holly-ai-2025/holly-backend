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
  const json = req.body.json === true;

  console.log('TTS request received', {
    json,
    promptLength: prompt ? prompt.length : 0,
  });
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // stop any existing session
  if (currentSession) {
    currentSession.abort();
  }

  const scriptPath = path.join(__dirname, '..', 'python', 'tts.py');
  const abortController = new AbortController();
  let closed = false;
  let python = null;
  let headersSent = false;
  let stderrBuffer = '';
  let audioBytes = 0;

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
        stream: true,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    if (response.body) {
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
    }

    console.log('LLM response length for TTS', textBuffer.length);

    if (json) {
      cleanup();
      return res.status(200).json({ response: textBuffer });
    }

    console.log('Spawning tts.py at', scriptPath);

    python = spawn('python3', [scriptPath, '--stream']);

    const isProbablyMp3 = (chunk) => {
      return (
        chunk.slice(0, 3).equals(Buffer.from('ID3')) ||
        (chunk[0] === 0xff && (chunk[1] & 0xe0) === 0xe0)
      );
    };

    python.stdout.on('data', (chunk) => {
      if (!headersSent) {
        console.log('First TTS chunk received', {
          length: chunk.length,
          firstBytes: chunk.slice(0, 10).toString('hex'),
        });
        if (!isProbablyMp3(chunk)) {
          stderrBuffer += 'Invalid MP3 header\n';
          console.error('Invalid MP3 header', chunk.slice(0, 10).toString('hex'));
          python.kill();
          return;
        }
        res.status(200);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Trailer', 'X-Transcript');
        headersSent = true;
      }
      audioBytes += chunk.length;
      res.write(chunk);
    });

    python.stderr.on('data', (data) => {
      const msg = data.toString();
      stderrBuffer += msg;
      console.error('TTS stderr:', msg);
    });

    python.on('close', (code) => {
      cleanup();
      if (!closed) {
        if (!headersSent || audioBytes === 0 || code !== 0) {
          console.error('tts.py exited with code', code, {
            headersSent,
            audioBytes,
            stderr: stderrBuffer,
          });
          if (!headersSent) {
            res.status(500).json({ error: 'TTS generation failed' });
          } else {
            res.end();
          }
        } else {
          res.addTrailers({ 'X-Transcript': textBuffer });
          res.end();
        }
      }
    });

    python.on('error', (err) => {
      cleanup();
      console.error('Failed to start tts.py:', err.message);
      if (!closed) {
        if (headersSent) {
          res.end();
        } else {
          res.status(500).json({ error: 'TTS process error' });
        }
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

    console.log('Sending text to tts.py for synthesis');
    python.stdin.write(textBuffer);
    python.stdin.end();
  } catch (error) {
    cleanup();
    console.error('Error querying Llama:', error.message);
    if (python) {
      python.kill();
    }
    if (!closed) {
      res.status(500).json({ error: 'Failed to generate speech' });
    }
  }
});

module.exports = router;
