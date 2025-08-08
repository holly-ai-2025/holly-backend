const express = require('express');
const cors = require('cors');

const app = express();

// reflect any origin; allow common headers/methods
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

// ensure all preflights succeed
app.options('*', cors());

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} origin=${req.headers.origin || '-'} ${ms}ms`);
  });
  next();
});

app.use(express.json());

// TTS route
app.use('/tts', require('./routes/tts'));

// Healthcheck
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

// Optional: plain 404 for everything else
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`✅ Holly backend running on http://localhost:${PORT}`);
});
