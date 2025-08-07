const express = require('express');
const cors = require('cors');

const app = express();

// Enable CORS from local frontend dev servers (5173 or 5174)
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174']
}));

// Parse incoming JSON
app.use(express.json());

// Route for TTS endpoint
const ttsRouter = require('./routes/tts.js');
app.use('/tts', ttsRouter);


// Start the server
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`✅ Holly backend running on http://localhost:${PORT}`);
});
