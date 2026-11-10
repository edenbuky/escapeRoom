const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const namespace = 'tdp-2026';
const context = 'tdp-wst2-dev-app-aks';

function run(command, args, capture = false) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
}
function parse(args) {
  const options = { dryRun: false, values: [] };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--dry-run') options.dryRun = true;
    else if (['--backend-image', '--values'].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      if (flag === '--values') options.values.push(path.resolve(value));
      else options.backend = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.backend || !/^[a-zA-Z0-9./:_@-]+$/.test(options.backend)
    || (!options.backend.includes('@sha256:') && !options.backend.split('/').pop().includes(':'))
    || options.backend.endsWith(':latest')) throw new Error('Provide a versioned --backend-image (not latest)');
  return options;
}

function main(args) {
  const options = parse(args);
  const chart = 'projecthon-team5-chart';
  const values = ['envs/dev.yaml'].flatMap(file => ['-f', `${chart}/${file}`]);
  for (const file of options.values) values.push('-f', file);
  const imageArgs = ['--set-string', `image.repository=${options.backend}`, '--set', 'fullStack.enabled=true'];
  run('helm', ['lint', chart, ...values, ...imageArgs]);
  if (options.dryRun) {
    run('helm', ['template', 'projecthon-team5', chart, '-n', namespace, ...values, ...imageArgs]);
    return;
  }
  const kube = ['--context', context, '-n', namespace, '--request-timeout=15s'];
  const get = (kind, name) => JSON.parse(run('kubectl', [...kube, 'get', kind, name, '-o', 'json'], true));
  for (const name of ['jfrog-registry', 'dev-ingress-tls']) get('secret', name);
  const runtime = get('secret', 'projecthon-team5-runtime');
  for (const key of ['JWT_ACCESS_SECRET', 'INTERNAL_API_TOKEN']) {
    const encoded = runtime.data?.[key];
    const value = encoded && Buffer.from(encoded, 'base64').toString('utf8');
    const bytes = value && Buffer.from(value, 'base64');
    if (!bytes || bytes.length < 32 || bytes.toString('base64') !== value) {
      throw new Error(`projecthon-team5-runtime must contain canonical base64 ${key} of at least 32 random bytes`);
    }
  }
  const ingress = get('ingress', 'projecthon-fe-teams');
  const rule = ingress.spec.rules.find(rule => rule.host === 'projecthon.dev.att.com');
  if (!rule?.http.paths.some(route => route.path === '/api/team5(/|$)(.*)'
    && route.backend.service.name === 'projecthon-team5'
    && route.backend.service.port.number === 80)
    || ingress.metadata.annotations?.['nginx.ingress.kubernetes.io/rewrite-target'] !== '/$2') {
    throw new Error('The existing Team 5 API ingress route is missing or incompatible; no deployment performed');
  }
  const helmVersion = run('helm', ['version', '--short'], true);
  const rollback = /^v4\./.test(helmVersion) ? '--rollback-on-failure' : '--atomic';
  run('helm', ['upgrade', '--install', 'projecthon-team5', chart, '--kube-context', context,
    '-n', namespace, ...values, ...imageArgs, rollback, '--wait', '--timeout', '10m']);
  run('kubectl', [...kube, 'rollout', 'status', 'deployment/projecthon-team5', '--timeout=120s']);
  const frontend = run('curl', ['--fail', '--silent', '--show-error', '--max-time', '30',
    'https://projecthon.dev.att.com/team5/'], true);
  if (!frontend.trim()) throw new Error('The shared frontend route returned an empty response');
  run('curl', ['--fail', '--silent', '--show-error', '--max-time', '30',
    'https://projecthon.dev.att.com/api/team5/health'], true);
  console.log('\nApplication ready: https://projecthon.dev.att.com/team5');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error('AKS deployment failed:', error.message.split('\n')[0]);
    process.exitCode = 1;
  }
}
module.exports = { parse, main };
