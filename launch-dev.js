#!/usr/bin/env node
// Reminder: configure GitHub access using SSH, not HTTPS, otherwise `git pull`
// will fail on headless environments like Vast.ai.

const { spawn, spawnSync, execSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// On Windows the npm executable is npm.cmd
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Remote Vast.ai host to ensure PM2 services
const vastHost = process.env.VAST_HOST;
const vastUser = process.env.VAST_USER || 'root';
const vastPort = process.env.VAST_PORT || '22';

// Ensure we're running from the backend directory
const backendDir = path.resolve(__dirname);
process.chdir(backendDir);

function runSync(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('📁 In backend directory:', backendDir);
const hasOrigin = spawnSync('git', ['remote']).stdout.toString().split('\n').includes('origin');
if (hasOrigin) {
  console.log('🔄 Pulling latest code from GitHub...');
  runSync('git', ['pull', 'origin', 'main']);
} else {
  console.log('⚠️ Skipping git pull; no origin remote configured.');
}

// Compute package.json hash to detect changes
const pkgPath = path.join(backendDir, 'package.json');
const pkgHash = crypto.createHash('sha256').update(fs.readFileSync(pkgPath)).digest('hex');
const hashFile = path.join(backendDir, 'node_modules', '.package-json-hash');
let lastHash;
try {
  lastHash = fs.readFileSync(hashFile, 'utf8').trim();
} catch (e) {}

if (pkgHash !== lastHash) {
  console.log('📦 package.json changed, running npm install...');
  runSync(npmCmd, ['install']);
  fs.writeFileSync(hashFile, pkgHash);
} else {
  console.log('📦 Dependencies up to date, skipping npm install.');
}

const commitHash = execSync('git rev-parse --short HEAD').toString().trim();
console.log(`🔖 Current commit: ${commitHash}`);

// Update remote backend and ensure PM2 services are running
function updateRemote() {
  if (!vastHost) {
    console.log('⚠️  VAST_HOST not set; skipping remote update.');
    return;
  }
  const remoteCmd = [
    'cd /root/holly-backend',
    'git fetch origin main',
    'git reset --hard origin/main',
    '(npm ci --omit=dev || npm install)',
    '(pm2 describe holly-backend || pm2 start /root/holly-backend/server.js --name holly-backend)',
    '(pm2 describe ollama || pm2 start "OLLAMA_HOST=0.0.0.0:11434 /usr/local/bin/ollama serve" --name ollama)',
    '(pm2 describe cloudflared || pm2 start cloudflared --name cloudflared -- tunnel run holly-backend)',
    'pm2 save'
  ].join(' && ');

  console.log('🔐 Updating remote...');
  const result = spawnSync('ssh', ['-p', vastPort, `${vastUser}@${vastHost}`, remoteCmd], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status === 0) {
    console.log('✅ Remote updated');
  } else {
    console.error(`❌ Remote update failed (code ${result.status})`);
  }
}

updateRemote();

// Utility to check if a TCP port is already in use
function isPortInUse(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', err => (err.code === 'EADDRINUSE' ? resolve(true) : resolve(false)))
      .once('listening', () => tester.once('close', () => resolve(false)).close())
      .listen(port);
  });
}

// Spawn a child process and mirror its output in the current terminal
function run(cmd, args, options = {}) {
  try {
    return spawn(cmd, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    });
  } catch (err) {
    console.error(`Failed to start ${cmd}:`, err.message);
  }
}

(async () => {
  const processes = [];

  // Start frontend dev server in ../holly-frontend if port 5173 is free
  if (!(await isPortInUse(5173))) {
    console.log('🚀 Starting frontend dev server...');
    const frontendDir = path.resolve(__dirname, '../holly-frontend');
    if (fs.existsSync(frontendDir)) {
      const frontend = run(npmCmd, ['run', 'dev'], { cwd: frontendDir });
      processes.push(frontend);
    } else {
      console.log(`⚠️  Frontend directory not found at ${frontendDir}, skipping.`);
    }
  } else {
    console.log('🔁 Frontend dev server already running on port 5173');
  }

  // Ensure all spawned processes are terminated if this script exits
  const cleanup = () => {
    processes.forEach(proc => {
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    });
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit();
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit();
  });
  process.on('exit', cleanup);
})();

