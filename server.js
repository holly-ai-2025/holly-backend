const express = require('express');
const cors = require('cors');

const app = express();

// Enable CORS only from the frontend origin
app.use(cors({
  origin: 'http://localhost:5173'
}));

// Parse incoming JSON
app.use(express.json());

// Route for LLaMA endpoint
const llmRouter = require('./routes/llm.js');
app.use('/llm', llmRouter);

// Start the server
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`✅ Holly backend running on http://localhost:${PORT}`);
});
