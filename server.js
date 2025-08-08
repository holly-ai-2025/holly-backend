const express = require('express');
const cors = require('cors');

const app = express();

// CORS: allow localhost dev + your Cloudflare domain
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    'https://api.hollyai.xyz',
  ],
}));

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
