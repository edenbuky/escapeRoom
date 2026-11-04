const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_PROJECT = 'projecthon-team5';

function runCompose(args) {
  const result = spawnSync('docker', ['compose', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function verifyProject() {
  const context = spawnSync('docker', [
    'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  const endpoint = context.stdout?.trim();
  if (context.error || context.status !== 0 || !/^(unix|npipe):\/\//.test(endpoint ?? '')) {
    throw new Error('Refusing reset: Docker must use a local unix or named-pipe context');
  }

  const result = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Unable to validate the local Docker Compose project');
  }
  const config = JSON.parse(result.stdout);
  if (config.name !== EXPECTED_PROJECT
    || config.services?.postgres?.image !== 'postgres:16-alpine'
    || config.services?.api?.image !== 'node:22-alpine') {
    throw new Error(`Refusing reset: expected local Compose project ${EXPECTED_PROJECT}`);
  }
}

if (process.cwd() !== ROOT) {
  process.stderr.write('Run this command from the repository root.\n');
  process.exit(1);
}
if (process.env.COMPOSE_PROJECT_NAME) {
  process.stderr.write('Unset COMPOSE_PROJECT_NAME; reset will not target an overridden project.\n');
  process.exit(1);
}
if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) {
  process.stderr.write('Unset Docker host/context overrides; reset requires the default local Docker context.\n');
  process.exit(1);
}
if (process.argv.length !== 3 || process.argv[2] !== '--confirm-local-reset') {
  process.stderr.write('This removes local project volumes. Re-run with --confirm-local-reset to continue.\n');
  process.exit(1);
}

try {
  verifyProject();
  runCompose(['down', '--volumes', '--remove-orphans']);
  runCompose(['run', '--rm', '--no-deps', 'workspace-init']);
  runCompose(['up', '-d', '--wait', 'postgres']);
  runCompose(['run', '--rm', 'api', 'npm', 'run', 'migration:run']);
  runCompose(['run', '--rm', 'api', 'npm', 'run', 'seed:admin']);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Local reset failed'}\n`);
  process.exit(1);
}