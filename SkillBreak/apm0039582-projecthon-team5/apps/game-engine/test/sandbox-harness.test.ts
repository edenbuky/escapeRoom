import childProcess from 'node:child_process';
import { SandboxHarness } from './helpers/sandbox-harness';

const originalContext = process.env.SANDBOX_KUBE_CONTEXT;
const originalKubeconfig = process.env.KUBECONFIG;
afterEach(() => {
  jest.restoreAllMocks();
  if (originalContext === undefined) delete process.env.SANDBOX_KUBE_CONTEXT;
  else process.env.SANDBOX_KUBE_CONTEXT = originalContext;
  if (originalKubeconfig === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = originalKubeconfig;
});

test('harness refuses implicit or non-local Kubernetes context before executing commands', () => {
  const command = jest.spyOn(childProcess, 'execFileSync');
  const harness = new SandboxHarness();
  delete process.env.SANDBOX_KUBE_CONTEXT;
  expect(() => harness.requireLocalRuntime()).toThrow('explicit');
  process.env.SANDBOX_KUBE_CONTEXT = 'corporate';
  process.env.KUBECONFIG = '/test/kubeconfig';
  expect(() => harness.requireLocalRuntime()).toThrow('explicit');
  expect(command).not.toHaveBeenCalled();
});

test('cleanup verifies test-run ownership and deletes exact owned UID, not labels or namespace', async () => {
  const harness = new SandboxHarness();
  process.env.SANDBOX_KUBE_CONTEXT = 'kind-skillbreak-local';
  process.env.KUBECONFIG = '/test/kubeconfig';
  const name = `sbx-${'a'.repeat(32)}`;
  const command = jest.spyOn(childProcess, 'execFileSync')
    .mockReturnValueOnce(JSON.stringify({ metadata: { uid: 'owned', labels: { 'team5.test-run': harness.runId } } }))
    .mockReturnValueOnce(`pod/${name}`)
    .mockReturnValue('');
  harness.ownPod(name);
  await harness.close();
  expect(command.mock.calls.map(call => call[1])).toEqual([
    ['--context=kind-skillbreak-local', 'get', 'pod', name, '-n', 'team5-sandboxes', '-o', 'json'],
    ['--context=kind-skillbreak-local', 'get', 'pod', name, '-n', 'team5-sandboxes', '--ignore-not-found', '-o', 'name'],
    ['--context=kind-skillbreak-local', 'delete', '--raw', `/api/v1/namespaces/team5-sandboxes/pods/${name}`, '-f', '-'],
    ['--context=kind-skillbreak-local', 'wait', '--for=delete', `pod/${name}`, '-n', 'team5-sandboxes', '--timeout=30s'],
  ]);
  expect(command.mock.calls[2][2]).toMatchObject({
    input: JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'owned' } }),
  });
});

test('unrelated pod ownership and failed cleanup never report success', async () => {
  const harness = new SandboxHarness();
  process.env.SANDBOX_KUBE_CONTEXT = 'kind-skillbreak-local';
  process.env.KUBECONFIG = '/test/kubeconfig';
  const name = `sbx-${'b'.repeat(32)}`;
  const command = jest.spyOn(childProcess, 'execFileSync').mockReturnValue(
    JSON.stringify({ metadata: { uid: 'unrelated', labels: {} } }));
  expect(() => harness.ownPod(name)).toThrow('unrelated');
  command.mockReturnValueOnce(JSON.stringify({ metadata: { uid: 'owned', labels: { 'team5.test-run': harness.runId } } }));
  harness.ownPod(name);
  command.mockImplementation(() => { throw new Error('private command error'); });
  await expect(harness.close()).rejects.toThrow('cleanup incomplete');
});
