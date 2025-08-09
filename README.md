# Holly Backend

This Node.js/Express backend powers Holly's features such as TTS. It listens on port **3001** and includes a helper script for local and remote development.

## TTS endpoint

`POST /tts` converts text into audio. Provide either `text` (the final reply from the LLM) or `prompt`. If `generate: true` is supplied with a `prompt`, the backend will call Ollama to produce the text before speaking it; otherwise the provided `text`/`prompt` is spoken directly so audio matches the displayed reply. Optional flags:

- `stream` – stream the MP3 as it's produced
- `json` – return `{ response: "..." }` instead of audio

Environment variables:

- `TTS_TEXT_MAX_CHARS` (default `600`): maximum characters sent to the TTS server before truncation.
- `TTS_TIMEOUT_MS` (default `60000`): timeout in milliseconds for each TTS request.

## Cloudflare Tunnel

A persistent [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) exposes the backend without opening firewall ports.

### Setup
1. Install the Cloudflare CLI:
   ```bash
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
   chmod +x /usr/local/bin/cloudflared
   ```
2. Authenticate with Cloudflare and create the tunnel:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create holly-backend
   ```
3. Route the tunnel to your domain:
   ```bash
   cloudflared tunnel route dns holly-backend api.hollyai.xyz
   ```
4. The repository includes `.cloudflared/config.yml` which maps the tunnel to `http://localhost:3001` and serves it at `https://api.hollyai.xyz`.

### Usage
- Start the backend and tunnel together:
  ```bash
  npm run launch
  ```
  or run the tunnel separately:
  ```bash
  npm run tunnel
  ```
- `npm run tunnel` uses `.cloudflared/config.yml` and exposes the backend at `https://api.hollyai.xyz`.
- Requests to `https://api.hollyai.xyz` will proxy to your local server on port 3001.
- These scripts assume `cloudflared` is installed at `/usr/local/bin/cloudflared`.

### Vast.ai or other remote servers
On a remote host:
1. Clone this repo and install dependencies (`npm install`).
2. Run `npm run launch` to start the backend and tunnel.
3. To keep services running after logout, run them under a process manager like [PM2](https://pm2.keymetrics.io/):
   ```bash
   npm install -g pm2
   npm run pm2
   pm2 startup
   ```

