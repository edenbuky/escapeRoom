const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const [action, ...args] = process.argv.slice(2);
if (!['build', 'test'].includes(action)) {
  process.stderr.write('Expected build or test.\n');
  process.exit(1);
}
function run(command) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...command], {
    cwd: root, stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write(`Foundation runner failed: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!process.env.npm_execpath) {
  process.stderr.write('Run through npm run build:foundation or npm run test:foundation.\n');
  process.exit(1);
}
run(['run', 'build', '--workspace', '@team5/contracts']);
run(['run', 'build', '--workspace', '@team5/messaging']);
if (action === 'build') {
  run(['run', 'build']);
  run(['run', 'build', '--workspace', '@team5/game-engine']);
} else {
  run(['run', 'typecheck', '--workspace', '@team5/contracts']);
  run(['run', 'typecheck', '--workspace', '@team5/messaging']);
  run(['run', 'typecheck', '--workspace', '@team5/game-engine']);
  run(['test', '--workspace', '@team5/contracts', '--', ...args]);
  run(['test', '--workspace', '@team5/messaging', '--', ...args]);
  run(['test', '--', ...args]);
  run(['test', '--workspace', '@team5/game-engine', '--', ...args]);
}
