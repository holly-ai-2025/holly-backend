const express = require('express');
const fetch = global.fetch || require('node-fetch');
const { Readable } = require('stream');

const router = express.Router();

// POST /tts
// Body: { text?, prompt?, generate=false, json=false, stream=false }
// - if json=true returns {response:text}
// - text skips LLM and proxies directly to FastAPI
// - prompt with generate=true will call Ollama once to create text
router.post('/', async (req, res) => {
  const {
    text,
    prompt,
    generate = false,
    json = false,
    stream = false,
  } = req.body || {};

  console.log('TTS request body', req.body);

  let spoken = text;

  // Optionally generate text via Ollama
  if (!spoken && prompt) {
    if (generate) {
      try {
        console.log('Fetching from Ollama...');
        const r = await fetch('http://localhost:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'llama3', prompt, stream: false }),
        });
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(
            `Ollama error: ${r.status} ${r.statusText} body=${body.slice(0,200)}`
          );
        }
        const data = await r.json().catch(() => null);
        spoken = data && typeof data.response === 'string' ? data.response : '';
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

  // Proxy to FastAPI TTS server
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const upstream = await fetch('http://127.0.0.1:5002/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: spoken }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      return res.status(500).json({
        stage: 'tts-upstream',
        status: upstream.status,
        error: errText.slice(0, 200),
      });
    }

    res.status(200);
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') || 'application/octet-stream'
    );
    res.setHeader(
      'Cache-Control',
      upstream.headers.get('cache-control') || 'no-store'
    );
    const conn = upstream.headers.get('connection');
    if (conn) res.setHeader('Connection', conn);
    res.setHeader('X-Transcript', spoken);

    if (stream) {
      res.setHeader('Transfer-Encoding', 'chunked');
      if (upstream.body.pipe) upstream.body.pipe(res);
      else Readable.from(upstream.body).pipe(res);
    } else {
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.setHeader(
        'Content-Length',
        upstream.headers.get('content-length') || String(buffer.length)
      );
      res.end(buffer);
    }
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timeout' : e.message;
    console.error('Error in TTS stage:', msg);
    return res
      .status(500)
      .json({ stage: 'tts', error: msg, code: null, signal: null });
  }
});

// GET /tts/selftest-json -> verifies FastAPI is alive
router.get('/selftest-json', async (req, res) => {
  try {
    const r = await fetch('http://127.0.0.1:5002/health');
    if (r.ok) {
      return res.json({ ok: true });
    }
    const body = await r.text().catch(() => '');
    return res.status(500).json({
      ok: false,
      status: r.status,
      error: body.slice(0, 200),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /tts/selftest-text -> synthesize "This is Holly self-test" and return WAV
router.get('/selftest-text', async (req, res) => {
  try {
    const upstreamUrl =
      process.env.TTS_SELFTEST_URL ||
      process.env.TTS_SERVER_URL ||
      'http://127.0.0.1:5002/speak';

    const r = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'This is Holly self-test' }),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(500).json({
        ok: false,
        error: txt.slice(0, 200) || `status ${r.status}`,
      });
    }

    const audioBuffer = Buffer.from(await r.arrayBuffer());
    res.status(200);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader(
      'Content-Disposition',
      'inline; filename="selftest.wav"'
    );
    res.setHeader('Content-Length', String(audioBuffer.length));
    res.send(audioBuffer);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;

