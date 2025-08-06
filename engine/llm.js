const fetch = global.fetch || require('node-fetch');

async function askLlama(prompt) {
  try {
    const response = await fetch('http://localhost:11111/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3',
        prompt: prompt,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error querying Llama:', error.message);
    throw error;
  }
}

module.exports = { askLlama };
