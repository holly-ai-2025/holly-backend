const express = require('express');
const fetch = global.fetch || require('node-fetch');
const { Readable } = require('stream');

const router = express.Router();

const TTS_TEXT_MAX_CHARS = parseInt(process.env.TTS_TEXT_MAX_CHARS || '600', 10);
const TTS_TIMEOUT_MS = parseInt(process.env.TTS_TIMEOUT_MS || '60000', 10);

// Helper: normalize & clamp speed param
function normalizeSpeed(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(2.0, Math.max(0.5, n));
}

// POST /tts
// Body: { text?, prompt?, generate=false, json=false, stream=false, speed? }
// - if json=true returns {response:text} (no audio)
// - text skips LLM and proxies directly to FastAPI
// - prompt with generate=true will call Ollama once to create text
// - stream=true proxies framed audio as it is produced (NO transcript headers)
router.post('/', async (req, res) => {
  const {
    text,
    prompt,
    generate = false,
    json = false,
    stream = false,
    sample_rate,
  } = req.body || {};

  // Optional tempo override (or use env TTS_SPEED as a default hint)
  const requestedSpeed =
    normalizeSpeed(req.body?.speed) ??
    normalizeSpeed(process.env.TTS_SPEED);

  console.log('TTS request body', {
    ...req.body,
    // avoid logging huge text
    text: text ? `${String(text).slice(0, 64)}…(${String(text).length})` : undefined,
    prompt: prompt ? `${String(prompt).slice(0, 64)}…(${String(prompt).length})` : undefined,
  });

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
            `Ollama error: ${r.status} ${r.statusText} body=${body.slice(0, 200)}`
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

  // STEP 1 path: return JSON transcript only (frontend shows text immediately)
  if (json) {
    // Plain JSON only; no transcript headers (to avoid header issues)
    return res.status(200).json({ response: spoken });
  }

  // Cap excessively long inputs (also helps with latency)
  if (spoken.length > TTS_TEXT_MAX_CHARS) {
    console.warn(
      `Truncating TTS text from ${spoken.length} to ${TTS_TEXT_MAX_CHARS}`
    );
    spoken = spoken.slice(0, TTS_TEXT_MAX_CHARS) + '…';
  }

  const start = Date.now();

  async function callUpstream() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
    try {
      // Forward "stream" flag and speed so FastAPI returns framed stream and faster tempo when requested
      const body = {
        text: spoken,
        stream,
      };
      if (requestedSpeed !== undefined) body.speed = requestedSpeed;
      if (sample_rate !== undefined) body.sample_rate = sample_rate;

      const r = await fetch('http://127.0.0.1:5002/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return r;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  let upstream;
  try {
    upstream = await callUpstream();
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('TTS upstream timeout, retrying once...');
      try {
        upstream = await callUpstream();
      } catch (e) {
        const elapsedMs = Date.now() - start;
        if (e.name === 'AbortError') {
          console.error('Error in TTS stage: timeout');
          return res
            .status(500)
            .json({ stage: 'tts', error: 'timeout', elapsedMs });
        }
        console.error('Error contacting TTS upstream:', e.message);
        return res.status(500).json({
          stage: 'tts-upstream',
          status: null,
          error: e.message.slice(0, 512),
          elapsedMs,
        });
      }
    } else {
      const elapsedMs = Date.now() - start;
      console.error('Error contacting TTS upstream:', err.message);
      return res.status(500).json({
        stage: 'tts-upstream',
        status: null,
        error: err.message.slice(0, 512),
        elapsedMs,
      });
    }
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    const elapsedMs = Date.now() - start;
    return res.status(500).json({
      stage: 'tts-upstream',
      status: upstream.status,
      error: errText.slice(0, 512),
      elapsedMs,
    });
  }

  // Common response headers (NO X-Transcript header at all)
  res.status(200);
  res.setHeader(
    'Cache-Control',
    upstream.headers.get('cache-control') || 'no-store'
  );

  const framing = upstream.headers.get('x-stream-framing');

  if (stream && framing) {
    // Streaming framed mini-WAVs from FastAPI
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Stream-Framing', framing);
    // Let browsers read the custom header via fetch()
    res.setHeader('Access-Control-Expose-Headers', 'X-Stream-Framing');
  } else {
    // Non-streaming: return the full WAV (or whatever upstream provided)
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') || 'audio/wav'
    );
  }

  if (stream) {
    // Streaming audio only — do NOT set transcript headers in streaming mode.
    // Let Node set Transfer-Encoding: chunked automatically when piping.
    const src = upstream.body.pipe ? upstream.body : Readable.from(upstream.body);
    src.pipe(res);
    src.on('end', () => {
      const elapsedMs = Date.now() - start;
      console.log(`TTS elapsedMs ${elapsedMs}`);
    });
    src.on('error', (e) => {
      console.error('Stream error from upstream:', e.message);
      try { res.end(); } catch (_) {}
    });
  } else {
    // Non-streaming: return full audio buffer
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader(
      'Content-Length',
      upstream.headers.get('content-length') || String(buffer.length)
    );
    res.end(buffer);
    const elapsedMs = Date.now() - start;
    console.log(`TTS elapsedMs ${elapsedMs}`);
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
    res.setHeader('Content-Disposition', 'inline; filename="selftest.wav"');
    res.setHeader('Content-Length', String(audioBuffer.length));
    res.send(audioBuffer);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
