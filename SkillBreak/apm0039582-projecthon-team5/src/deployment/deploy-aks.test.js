jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));
const { execFileSync } = require('node:child_process');
const { parse, main } = require('../../scripts/deploy-aks');

const images = ['--backend-image', 'registry.example/team5:1.2.3'];
const secret = Buffer.from(Buffer.alloc(32, 7).toString('base64')).toString('base64');

beforeEach(() => {
  execFileSync.mockReset();
  execFileSync.mockImplementation((command, args) => {
    if (command === 'helm' && args[0] === 'version') return 'v4.3.1';
    if (command === 'kubectl' && args.includes('get')) {
      if (args.includes('projecthon-team5-runtime')) return JSON.stringify({ data: { JWT_ACCESS_SECRET: secret, INTERNAL_API_TOKEN: secret } });
      if (args.includes('ingress')) return JSON.stringify({ metadata: { annotations: {
        'nginx.ingress.kubernetes.io/rewrite-target': '/$2' } }, spec: { rules: [{ host: 'projecthon.dev.att.com',
        http: { paths: [{ path: '/api/team5(/|$)(.*)', backend: { service: {
          name: 'projecthon-team5', port: { number: 80 },
        } } }] } }] } });
      return '{}';
    }
    if (command === 'curl') return '<!doctype html>';
    return '';
  });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

test.each([[], ['--backend-image', 'registry/team5:latest'], ['--unexpected'], ['--backend-image']].map(args => [args]))(
  'rejects incomplete or unversioned image arguments', args => {
    expect(() => parse(args)).toThrow();
  });
test('rejects frontend image arguments because the shared frontend is independently deployed', () => {
  expect(() => parse([...images, '--frontend-image', 'registry/frontend:1.2.3'])).toThrow('Unknown option');
});
test('dry-run renders only and never accesses or mutates the cluster', () => {
  main([...images, '--dry-run']);
  expect(execFileSync.mock.calls.map(([command]) => command)).toEqual(['helm', 'helm']);
  expect(execFileSync.mock.calls[1][1][0]).toBe('template');
});
test('one command checks prerequisites, deploys the backend release and verifies shared routing', () => {
  main(images);
  const upgrade = execFileSync.mock.calls.find(([command, args]) => command === 'helm' && args[0] === 'upgrade');
  expect(upgrade[1]).toEqual(expect.arrayContaining(['projecthon-team5', 'tdp-2026', '--rollback-on-failure', '--wait']));
  expect(upgrade[1].join(' ')).not.toContain('frontend');
  const rollouts = execFileSync.mock.calls.filter(([command, args]) => command === 'kubectl' && args.includes('rollout'));
  expect(rollouts).toHaveLength(1);
  expect(rollouts[0][1]).toEqual(expect.arrayContaining(['deployment/projecthon-team5']));
  expect(execFileSync.mock.calls.some(([command]) => command === 'docker')).toBe(false);
});
test('missing runtime secret prevents any helm upgrade', () => {
  execFileSync.mockImplementation((command, args) => {
    if (command === 'kubectl' && args.includes('projecthon-team5-runtime')) throw new Error('NotFound');
    return '{}';
  });
  expect(() => main(images)).toThrow('NotFound');
  expect(execFileSync.mock.calls.some(([, args]) => args[0] === 'upgrade')).toBe(false);
});
test('incompatible shared routing prevents deployment', () => {
  const previous = execFileSync.getMockImplementation();
  execFileSync.mockImplementation((command, args, options) =>
    command === 'kubectl' && args.includes('ingress')
      ? JSON.stringify({ metadata: {}, spec: { rules: [] } }) : previous(command, args, options));
  expect(() => main(images)).toThrow('ingress route');
  expect(execFileSync.mock.calls.some(([, args]) => args[0] === 'upgrade')).toBe(false);
});
