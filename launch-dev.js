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
console.log('🔄 Pulling latest code from GitHub...');
runSync('git', ['pull', 'origin', 'main']);

console.log('🔄 Syncing remote Vast.ai backend with latest GitHub commit...');
const remotePullCmd = `
  cd /root/holly-backend &&
  LOCAL_HASH=$(git rev-parse HEAD) &&
  git fetch origin main &&
  REMOTE_HASH=$(git rev-parse origin/main) &&
  if [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
    echo "🔄 Updating remote backend...";
    git reset --hard origin/main;
  else
    echo "✅ Remote backend already up to date.";
  fi
`.trim();
runSync('ssh', ['-p', '50015', 'root@99.243.100.183', remotePullCmd]);

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

  // Establish SSH tunnel to Vast.ai instance if not already running
  if (!(await isPortInUse(11111))) {
      const ssh = run('ssh', ['-N', '-L', '11111:localhost:11434', '-p', '50015', 'root@99.243.100.183']);
    processes.push(ssh);

    // Ensure remote Ollama server is running
      const remoteCmd = [
        "if ! ss -tuln | grep -q ':11434'; then",
        'OLLAMA_HOST=0.0.0.0:11434 nohup ollama serve >/tmp/ollama.log 2>&1 &',
        'fi'
      ].join(' ');
      run('ssh', ['-p', '50015', 'root@99.243.100.183', remoteCmd]);
  } else {
    console.log('🔁 SSH tunnel already running on port 11111');
  }

  // Start backend server (server.js) if port 3001 is free
  if (!(await isPortInUse(3001))) {
    console.log('🚀 Starting backend server...');
    const backend = run('node', ['server.js']);
    processes.push(backend);
  } else {
    console.log('🔁 Backend server already running on port 3001');
  }

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

