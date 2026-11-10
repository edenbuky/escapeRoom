#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node - "$root" <<'NODE'
const { execFileSync, spawn } = require('node:child_process');
const root = process.argv[2];
const env = {
  ...process.env,
  NPM_USER_CONFIG: process.env.HOME + '/.npmrc',
  SANDBOX_BUILD_NPMRC: process.env.HOME + '/.npmrc',
  SANDBOX_KUBE_CONTEXT: 'kind-skillbreak-local',
  KUBECONFIG: root + '/.local/gameplay.kubeconfig',
  SANDBOX_IMAGE_ALLOWLIST: 'localhost:5001/room1-sql',
  CORS_ORIGINS: 'http://127.0.0.1:5174,http://localhost:5173',
  GAMEPLAY_DEBUG_LOGS: process.env.GAMEPLAY_DEBUG_LOGS ?? 'true',
};
try {
  for (const [container, prefix] of [
    ['projecthon-team5-engine-1', 'ENGINE_DB_'],
    ['projecthon-team5-api-1', 'DB_'],
  ]) {
    const config = JSON.parse(execFileSync('docker', ['inspect', container], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }))[0];
    const previous = Object.fromEntries(config.Config.Env.map(entry => {
      const split = entry.indexOf('=');
      return [entry.slice(0, split), entry.slice(split + 1)];
    }));
    for (const key of ['USER', 'PASSWORD', 'NAME']) {
      if (!previous[prefix + key]) throw new Error('Missing database setting');
      env[prefix + key] = previous[prefix + key];
    }
  }
} catch {
  console.error('Cannot read saved local database settings. Make sure Docker is running and the existing projecthon-team5 api/engine containers are present.');
  process.exit(1);
}
if (env.GAMEPLAY_DEBUG_LOGS === 'true' && env.NODE_ENV !== 'production') {
  console.warn('Local gameplay debug logs include SQL, submitted hashes, and Dana puzzle usernames/passwords in this terminal and room1-trail.log. Do not enter real passwords or share this log.');
}
const child = spawn('sh', [root + '/scripts/demo-room1.sh', 'kind'], {
  cwd: root, env, stdio: 'inherit',
});
child.on('error', () => {
  console.error('Could not start the backend demo script.');
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
NODE