import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve(__dirname, '../../../scripts/check-local-runtime.sh');
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'skillbreak-runtime-test-'));
  writeFileSync(join(directory, 'kubeconfig'), 'test-only');
  writeFileSync(join(directory, 'kubectl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  *"cluster-info"*) [ "$SCENARIO" != context ]; exit $? ;;
  *"get runtimeclass"*) [ "$SCENARIO" != class ] || exit 1; printf runc ;;
  *"get namespace"*) printf skillbreak-foundation ;;
  *"get pods"*) [ "$SCENARIO" != collision ] || printf pod/existing ;;
  *"create -f"*) cat > /dev/null; printf pod/skillbreak-runtime-smoke-test ;;
  *"get pod"*"jsonpath"*) case "$SCENARIO" in failed) printf Failed;; timeout) printf Pending;; *) printf Succeeded;; esac ;;
  *"delete pod/"*) [ "$SCENARIO" != cleanup ] || exit 1 ;;
esac
`, { mode: 0o755 });
});
afterEach(() => { rmSync(directory, { recursive: true }); });

test.each(['success', 'context', 'class', 'collision', 'failed', 'timeout', 'cleanup'])('runtime helper handles %s without touching another context', scenario => {
  const result = spawnSync('sh', [script], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, KUBECONFIG: join(directory, 'kubeconfig'),
      CALLS: join(directory, 'calls'), SCENARIO: scenario, SANDBOX_RUNTIME_CLASS: 'runc', RUNTIME_CHECK_TIMEOUT_SECONDS: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(scenario === 'success' ? 0 : 1);
  const calls = readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n');
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call).toContain('--context kind-skillbreak-local');
    expect(call).toContain('--kubeconfig');
  }
  const deletes = calls.filter(call => call.includes('delete '));
  if (['context', 'class', 'collision'].includes(scenario)) expect(deletes).toEqual([]);
  else expect(deletes).toHaveLength(1);
  for (const call of deletes) expect(call).toContain('delete pod/skillbreak-runtime-smoke-test');
});
