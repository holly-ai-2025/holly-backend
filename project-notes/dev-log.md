## ✅ 2025-08-06 – LLaMA Backend Integration Begins

- Created `engine/llm.js` to connect backend to live LLaMA 3.1 8B model hosted on Vast.ai
- Verified Ollama API running on port 50093
- Logged setup for repeatability and future upgrades

## ✅ 2025-08-06 – LLaMA API Endpoint

- Added `routes/llm.js` to expose `/llm` POST route
- Frontend or tools can now send prompts to LLaMA backend
