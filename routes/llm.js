const express = require('express');
const router = express.Router();

const { askLlama } = require('../engine/llm.js');

router.post('/', async (req, res) => {
  const { prompt } = req.body;

  try {
    const response = await askLlama(prompt);
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
