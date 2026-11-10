import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(__dirname, '../../..');
const script = resolve(root, 'scripts/setup-sandbox-local.sh');

test.each([
  { arg: '--unknown', context: 'kind-skillbreak-local', error: 'Usage:' },
  { arg: '--check', context: 'corporate', error: 'SANDBOX_KUBE_CONTEXT' },
  { arg: '--check', context: 'kind-skillbreak-local', error: 'kubeconfig' },
])('setup rejects unsafe or missing prerequisites without a fallback context: $error', ({ arg, context, error }) => {
  const result = spawnSync('sh', [script, arg], { encoding: 'utf8', timeout: 5000,
    env: { ...process.env, SANDBOX_KUBE_CONTEXT: context, KUBECONFIG: resolve(root, '.local/nonexistent-test-kubeconfig') } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(error);
});

test('local config explicitly selects enforcing networking and a real kubelet PID limit', () => {
  const config = readFileSync(resolve(root, 'infra/local/kind.yaml'), 'utf8');
  expect(config).toContain('disableDefaultCNI: true');
  expect(config).toContain('podPidsLimit: 64');
  expect(config).toMatch(/kindest\/node:v1\.\d+\.\d+@sha256:[a-f0-9]{64}/);
  const setup = readFileSync(script, 'utf8');
  expect(setup).toContain('FELIX_DEFAULTENDPOINTTOHOSTACTION=ACCEPT');
  expect(setup).toContain('rollout status deployment/calico-kube-controllers');
  expect(setup).toContain('shasum -a 256');
  expect(setup).not.toMatch(/kind delete|docker (rm|system prune)|kubectl config use-context/);
});

test.each([
  ['cni', 'Calico is not ready'],
  ['runtime', 'runc handler missing'],
])('read-only setup check rejects a missing %s without mutating resources', (failure, message) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'sandbox-negative-check-'));
  try {
    const kubeconfig = resolve(directory, 'owned-kubeconfig');
    const kind = resolve(directory, 'kind');
    const log = resolve(directory, 'commands');
    writeFileSync(kubeconfig, '');
    writeFileSync(kind, "#!/bin/sh\nprintf 'kind v0.33.0 go1.24 linux/arm64\\n'\n", { mode: 0o755 });
    writeFileSync(resolve(directory, 'docker'), "#!/bin/sh\nprintf 'sql-sandbox-local\\n'\n", { mode: 0o755 });
    writeFileSync(resolve(directory, 'kubectl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  *jsonpath=*metadata.annotations*) printf 'calico-v3.33.0-pids64-v2' ;;
  *--raw*) printf '{"kubeletconfig":{"podPidsLimit":64}}' ;;
  *'rollout status daemonset/calico-node'*) [ "$TEST_FAILURE" != cni ] ;;
  *'get runtimeclass runc'*) [ "$TEST_FAILURE" = runtime ] || printf runc ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    const result = spawnSync('sh', [script, '--check'], { encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, KIND_BIN: kind,
        KUBECONFIG: kubeconfig, SANDBOX_KUBE_CONTEXT: 'kind-skillbreak-local', TEST_FAILURE: failure, COMMAND_LOG: log } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(readFileSync(log, 'utf8')).not.toMatch(/\b(apply|patch|create|delete)\b/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
