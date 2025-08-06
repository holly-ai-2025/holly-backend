## ✅ 2025-08-06 – LLaMA Backend Integration Begins

- Created `engine/llm.js` to connect backend to live LLaMA 3.1 8B model hosted on Vast.ai
- Verified Ollama API running on port 50093
- Logged setup for repeatability and future upgrades

## ✅ 2025-08-06 – LLaMA API Endpoint

- Added `routes/llm.js` to expose `/llm` POST route
- Frontend or tools can now send prompts to LLaMA backend

## ✅ 2025-08-06 – Backend Server + LLaMA API

- Created `server.js` to run the Express backend on port 3001
- Connected route handler from `routes/llm.js` to accept POST prompts
- Backend can now receive prompts from the frontend and pass them to the LLaMA 3.1 model via Ollama
- Confirmed Ollama is still accessible at `http://99.243.100.183:50093`

