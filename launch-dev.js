const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

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
  return spawn(cmd, args, { stdio: 'inherit', shell: true, ...options });
}

(async () => {
  const processes = [];

  // Establish SSH tunnel to Vast.ai instance if not already running
  if (!(await isPortInUse(11111))) {
    const ssh = run('ssh', ['-N', '-L', '11111:localhost:11434', '-p', '50015', 'root@99.243.100.183']);
    processes.push(ssh);

    // Ensure remote Ollama server is running
    const remoteCmd =
      "if ! ss -tuln | grep -q ':11434'; then " +
      'OLLAMA_HOST=0.0.0.0:11434 nohup ollama serve >/tmp/ollama.log 2>&1 & fi';
    run('ssh', [`-p 50015 root@99.243.100.183 "${remoteCmd}"`]);
  } else {
    console.log('🔁 SSH tunnel already running on port 11111');
  }

  // Start backend server (server.js) if port 3001 is free
  if (!(await isPortInUse(3001))) {
    const backend = run('node', ['server.js']);
    processes.push(backend);
  } else {
    console.log('🔁 Backend server already running on port 3001');
  }

  // Start frontend dev server in ../holly-frontend if port 5173 is free
  if (!(await isPortInUse(5173))) {
    const frontend = run('npm', ['run', 'dev'], { cwd: path.resolve(__dirname, '../holly-frontend') });
    processes.push(frontend);
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

