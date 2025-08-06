const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const fs = require('fs');

router.post('/', (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }

  const python = spawn('python3', ['tts.py', text]);
  let stdout = '';
  let stderr = '';

  python.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  python.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  python.on('error', () => {
    return res.status(500).json({ error: 'TTS script not found' });
  });

  python.on('close', (code) => {
    if (code !== 0) {
      console.error(stderr);
      return res.status(500).json({ error: 'TTS generation failed' });
    }

    const filePath = stdout.trim().split('\n').slice(-1)[0];
    res.setHeader('Content-Type', 'audio/mpeg');
    const stream = fs.createReadStream(filePath);

    stream.on('error', (err) => {
      console.error(err);
      res.status(500).end();
    });

    stream.pipe(res);

    req.on('close', () => {
      python.kill();
      stream.destroy();
    });

    stream.on('close', () => {
      fs.unlink(filePath, () => {});
    });
  });
});

module.exports = router;
