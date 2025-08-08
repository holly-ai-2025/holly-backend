const express = require('express');
const cors = require('cors');

const app = express();

// Enable CORS for any requesting origin
app.use(cors({ origin: true }));

// Parse incoming JSON
app.use(express.json());

// Route for TTS endpoint
const ttsRouter = require('./routes/tts.js');
app.use('/tts', ttsRouter);

// Simple health check
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});


// Start the server
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`✅ Holly backend running on http://localhost:${PORT}`);
});
