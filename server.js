const express = require('express');
const app = express();

app.use(express.json());

const llmRouter = require('./routes/llm.js');
app.use('/llm', llmRouter);

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
