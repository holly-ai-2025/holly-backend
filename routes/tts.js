const express = require('express');
const cors = require('cors');
const fetch = global.fetch || require('node-fetch');
const { spawn } = require('child_process');
const path = require('path');

const router = express.Router();
router.use(cors());

// Track one TTS session at a time
let currentSession = null;

router.post('/', async (req, res) => {
  const { prompt, json = false, stream = false } = req.body || {};

  console.log('TTS request body', req.body);

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // Stop any existing session
  if (currentSession) {
    try {
      currentSession.abort();
    } catch {}
  }

  const scriptPath = path.join(__dirname, '..', 'python', 'tts.py');
  let python = null;
  let headersSent = false;
  let stderrBuffer = '';
  let audioBytes = 0;
  const chunks = [];
  let streamingAudio = false;
  let closed = false;

  const cleanup = () => {
    if (currentSession && currentSession.python === python) {
      currentSession = null;
    }
  };

  // Kill only Python if audio started
  req.on('close', () => {
    closed = true;
    if (streamingAudio && python) {
      try {
        python.kill();
      } catch {}
    }
    cleanup();
  });

  let textBuffer = '';

  try {
    console.log('Fetching from Ollama...');
    const llamaResp = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3',
        prompt,
        stream: true
      })
      // ❌ No abortController.signal here
    });

    if (!llamaResp.ok) {
      throw new Error(`HTTP error from Ollama: ${llamaResp.status}`);
    }

    if (llamaResp.body) {
      for await (const chunk of llamaResp.body) {
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

    console.log('Spawning Python TTS at', scriptPath);
    python = spawn('python3', [scriptPath, '--stream']);

    const isProbablyMp3 = (chunk) =>
      chunk.slice(0, 3).equals(Buffer.from('ID3')) ||
      (chunk[0] === 0xff && (chunk[1] & 0xe0) === 0xe0);

    let firstChunk = true;

    python.stdout.on('data', (chunk) => {
      if (firstChunk) {
        console.log('First TTS chunk received', {
          length: chunk.length,
          firstBytes: chunk.slice(0, 10).toString('hex')
        });
        if (!isProbablyMp3(chunk)) {
          stderrBuffer += 'Invalid MP3 header\n';
          console.error('Invalid MP3 header', chunk.slice(0, 10).toString('hex'));
          python.kill();
          return;
        }
        res.status(200);
        res.setHeader('Content-Type', 'audio/mpeg');
        if (stream) {
          res.setHeader('Transfer-Encoding', 'chunked');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('Trailer', 'X-Transcript');
        } else {
          res.setHeader('Content-Disposition', 'inline; filename="output.mp3"');
        }
        headersSent = true;
        streamingAudio = true;
        firstChunk = false;
      }

      audioBytes += chunk.length;
      if (stream) {
        res.write(chunk);
      } else {
        chunks.push(chunk);
      }
    });

    python.stderr.on('data', (data) => {
      const msg = data.toString();
      stderrBuffer += msg;
      console.error('TTS stderr:', msg);
    });

    python.on('close', (code) => {
      cleanup();
      const success = audioBytes > 0 && code === 0;
      if (!success) {
        console.error('tts.py exited with code', code, {
          headersSent,
          audioBytes,
          stderr: stderrBuffer
        });
        if (!headersSent) {
          return res.status(500).json({ error: 'TTS generation failed' });
        }
        return res.end();
      }

      if (stream) {
        res.addTrailers({ 'X-Transcript': textBuffer });
        res.end();
      } else {
        const audioBuffer = Buffer.concat(chunks);
        res.setHeader('Content-Length', audioBuffer.length);
        res.setHeader('X-Transcript', textBuffer);
        res.send(audioBuffer);
      }
    });

    python.on('error', (err) => {
      cleanup();
      console.error('Failed to start tts.py:', err.message);
      if (!headersSent) {
        res.status(500).json({ error: 'TTS process error' });
      } else {
        res.end();
      }
    });

    // Allow manual abort
    currentSession = {
      python,
      abort: () => {
        try {
          python.kill();
        } catch {}
      }
    };
  } catch (err) {
    cleanup();
    console.error('Error in /tts:', err.message);
    if (!headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

module.exports = router;
