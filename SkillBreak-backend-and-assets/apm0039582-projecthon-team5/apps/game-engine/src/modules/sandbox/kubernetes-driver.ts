import { createHash, randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import type { ProvisionJob, SandboxIdentity } from './sandbox.contracts';
import { SandboxExecutionError } from './sandbox-errors';
import { validateSandboxIdentity } from './sandbox.repository';
import { sandboxIdentity } from '../sessions/core/ids';

export interface KubernetesOptions {
  runtimeClass: string;
  kubeContext?: string;
  imageAllowlist: string[];
}

export function validatePinnedImage(image: string, allowlist: string[]): string {
  const match = image.match(/^(.+)@sha256:[0-9a-f]{64}$/);
  if (!match || !allowlist.includes(match[1])) throw new SandboxExecutionError('imageNotPinned');
  return image;
}

export function sqlPod(job: ProvisionJob, runtimeClass: string) {
  const id = validateSandboxIdentity(job);
  const labels: Record<string, string> = {
    'app.kubernetes.io/name': 'skillbreak-sql', 'team5.sandbox': id, 'team5.session': job.sessionId,
    'team5.puzzle': createHash('sha256').update(job.puzzleKey).digest('hex').slice(0, 32),
    'team5.generation': String(job.generation),
  };
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: job.podName, namespace: job.namespace, labels,
      annotations: { 'team5.policy': job.policyRef, 'team5.seed': job.seedRef ?? '' } },
    spec: {
      runtimeClassName: runtimeClass, restartPolicy: 'Never', terminationGracePeriodSeconds: 1,
      automountServiceAccountToken: false, enableServiceLinks: false, hostNetwork: false, hostPID: false, hostIPC: false,
      securityContext: { runAsNonRoot: true, runAsUser: 70, runAsGroup: 70, fsGroup: 70,
        seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{
        name: 'sql', image: job.imageDigest, imagePullPolicy: 'IfNotPresent',
        securityContext: { privileged: false, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] }, procMount: 'Default' },
        resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
        volumeMounts: [
          { name: 'data', mountPath: '/var/lib/postgresql/data' },
          { name: 'socket', mountPath: '/run/postgresql' },
          { name: 'tmp', mountPath: '/tmp' },
        ],
      }],
      volumes: [
        { name: 'data', emptyDir: { medium: 'Memory', sizeLimit: '56Mi' } },
        { name: 'socket', emptyDir: { medium: 'Memory', sizeLimit: '4Mi' } },
        { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '4Mi' } },
      ],
    },
  };
}

function subset(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((value, i) => subset(value, actual[i]));
  }
  return Object.entries(expected).every(([key, value]) => key in actual && subset(value, Reflect.get(actual, key)));
}

export function assertOwnedPod(job: ProvisionJob, runtimeClass: string, pod: unknown, uid?: string): void {
  const expected = sqlPod(job, runtimeClass);
  if (!pod || typeof pod !== 'object' || !('metadata' in pod)
    || !pod.metadata || typeof pod.metadata !== 'object' || !('uid' in pod.metadata)
    || typeof pod.metadata.uid !== 'string' || (uid !== undefined && uid !== pod.metadata.uid)) {
    throw new SandboxExecutionError('ownershipConflict');
  }
  if (!('spec' in pod) || !pod.spec || typeof pod.spec !== 'object') throw new SandboxExecutionError('ownershipConflict');
  const normalized = { ...pod, spec: { ...pod.spec,
    hostNetwork: Reflect.get(pod.spec, 'hostNetwork') ?? false,
    hostPID: Reflect.get(pod.spec, 'hostPID') ?? false,
    hostIPC: Reflect.get(pod.spec, 'hostIPC') ?? false,
  } };
  if (!subset(expected, normalized)) throw new SandboxExecutionError('ownershipConflict');
  for (const field of ['initContainers', 'ephemeralContainers', 'imagePullSecrets']) {
    const value: unknown = Reflect.get(pod.spec, field);
    if (value !== undefined && (!Array.isArray(value) || value.length)) throw new SandboxExecutionError('ownershipConflict');
  }
  const containers: unknown = Reflect.get(pod.spec, 'containers');
  if (!Array.isArray(containers)) throw new SandboxExecutionError('ownershipConflict');
  for (const container of containers) {
    if (!container || typeof container !== 'object') throw new SandboxExecutionError('ownershipConflict');
    for (const field of ['env', 'envFrom', 'command', 'args', 'ports']) {
      const value: unknown = Reflect.get(container, field);
      if (value !== undefined && (!Array.isArray(value) || value.length)) throw new SandboxExecutionError('ownershipConflict');
    }
  }
}

async function connectKubernetes(context?: string) {
  const client = await import('@kubernetes/client-node');
  const config = new client.KubeConfig();
  if (context !== undefined) {
    if (context !== 'kind-skillbreak-local' || !process.env.KUBECONFIG) throw new SandboxExecutionError('runtimeUnavailable');
    config.loadFromFile(process.env.KUBECONFIG);
    if (!config.getContexts().some(value => value.name === context)) throw new SandboxExecutionError('runtimeUnavailable');
    config.setCurrentContext(context);
  } else {
    config.loadFromCluster();
  }
  const core = config.makeApiClient(client.CoreV1Api);
  const apiOptions: NonNullable<Parameters<typeof core.readNamespacedPod>[1]> = {
    middlewareMergeStrategy: 'append',
    middleware: [{ pre: request => {
      request.setSignal(AbortSignal.timeout(2000));
      return new client.Observable(Promise.resolve(request));
    }, post: response => new client.Observable(Promise.resolve(response)) }],
  };
  return { core, exec: new client.Exec(config), apiOptions };
}
type Clients = Awaited<ReturnType<typeof connectKubernetes>>;

function apiStatus(error: unknown, code: number): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

export class KubernetesDriver {
  private clients?: Promise<Clients>;
  private readonly logger = new Logger(KubernetesDriver.name);

  constructor(readonly options: KubernetesOptions) {}

  private client(): Promise<Clients> {
    this.clients ??= connectKubernetes(this.options.kubeContext);
    return this.clients;
  }

  async confirmAbsent(identity: SandboxIdentity): Promise<boolean> {
    validateSandboxIdentity(identity);
    try {
      const { core, apiOptions } = await this.client();
      await core.readNamespacedPod({ name: identity.podName, namespace: identity.namespace }, apiOptions);
      return false;
    } catch (error) {
      if (apiStatus(error, 404)) return true;
      throw this.failure(error);
    }
  }

  async checkAvailable(): Promise<void> {
    try {
      const { core, apiOptions } = await this.client();
      await core.listNamespacedPod({ namespace: 'team5-sandboxes', limit: 1 }, apiOptions);
    } catch (error) { throw this.failure(error); }
  }

  async read(job: ProvisionJob, uid?: string) {
    validateSandboxIdentity(job);
    try {
      const { core, apiOptions } = await this.client();
      const pod = await core.readNamespacedPod({ name: job.podName, namespace: job.namespace }, apiOptions);
      assertOwnedPod(job, this.options.runtimeClass, pod, uid);
      return pod;
    } catch (error) {
      if (apiStatus(error, 404)) return null;
      throw this.failure(error);
    }
  }

  async ensure(job: ProvisionJob, testRun?: string) {
    validatePinnedImage(job.imageDigest, this.options.imageAllowlist);
    if (job.seedRef !== 'room1-sql-v1' || !/^idan-db-sql@[1-9][0-9]*$/.test(job.policyRef)) {
      throw new SandboxExecutionError('templateMismatch');
    }
    const existing = await this.read(job);
    if (existing) return existing;
    const pod = sqlPod(job, this.options.runtimeClass);
    pod.metadata.labels = { ...pod.metadata.labels, ...(testRun ? { 'team5.test-run': testRun } : {}) };
    try {
      const { core, apiOptions } = await this.client();
      const created = await core.createNamespacedPod({ namespace: job.namespace, body: pod }, apiOptions);
      assertOwnedPod(job, this.options.runtimeClass, created);
      return created;
    } catch (error) {
      if (apiStatus(error, 409)) {
        const adopted = await this.read(job);
        if (adopted) return adopted;
      }
      throw this.failure(error);
    }
  }

  async remove(job: ProvisionJob, uid: string): Promise<void> {
    const pod = await this.read(job, uid);
    if (!pod) return;
    try {
      const { core, apiOptions } = await this.client();
      await core.deleteNamespacedPod({ name: job.podName, namespace: job.namespace,
        body: { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid }, gracePeriodSeconds: 1 } }, apiOptions);
      const deadline = Date.now() + 10000;
      while (await this.read(job, uid)) {
        if (Date.now() >= deadline) throw new SandboxExecutionError('runtimeUnavailable');
        await delay(100);
      }
    } catch (error) {
      if (apiStatus(error, 404)) return;
      throw this.failure(error);
    }
  }

  async helper(job: ProvisionJob, uid: string, mode: 'ready' | 'query' | 'status' | 'cancel' | 'inspect',
    input: Record<string, unknown> = {}, timeoutMs = 6000): Promise<unknown> {
    if (!await this.read(job, uid)) throw new SandboxExecutionError('notReady');
    return this.execHelper(job.namespace, job.podName, mode, input, timeoutMs);
  }

  private async execHelper(namespace: string, podName: string, mode: string,
    input: Record<string, unknown> = {}, timeoutMs = 6000): Promise<unknown> {
    const json = JSON.stringify({ version: 1, ...input });
    if (Buffer.byteLength(json) > 32768 || timeoutMs < 1 || timeoutMs > 7000) throw new SandboxExecutionError('policyBlocked');
    const { exec } = await this.client();
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const stdout: Buffer[] = [];
        let size = 0;
        let done = false;
        let socket: Awaited<ReturnType<Clients['exec']['exec']>> | undefined;
        const finish = (error?: SandboxExecutionError, result?: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          socket?.close();
          if (error) reject(error); else resolve(result);
        };
        const timer = setTimeout(() => finish(new SandboxExecutionError('runtimeUnavailable')), timeoutMs);
        const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > 512 * 1024) finish(new SandboxExecutionError('runtimeUnavailable'));
          else stdout.push(Buffer.from(chunk));
          callback();
        } });
        const diagnostic = new Writable({ write(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > 512 * 1024) finish(new SandboxExecutionError('runtimeUnavailable'));
          callback();
        } });
        void exec.exec(namespace, podName, 'sql', ['node', '/opt/sql/query-helper.mjs', mode],
          output, diagnostic, Readable.from([json]), false, status => {
            if (status.status !== 'Success') { finish(new SandboxExecutionError('runtimeUnavailable')); return; }
            try { finish(undefined, JSON.parse(Buffer.concat(stdout).toString('utf8'))); }
            catch { finish(new SandboxExecutionError('runtimeUnavailable')); }
          }).then(value => {
            socket = value;
            if (done) { socket.close(); return; }
            socket.on('error', () => finish(new SandboxExecutionError('runtimeUnavailable')));
            socket.on('close', () => { if (!done) finish(new SandboxExecutionError('runtimeUnavailable')); });
          }, () => finish(new SandboxExecutionError('runtimeUnavailable')));
      });
    } catch (error) { throw this.failure(error); }
  }

  async preflight(imageDigest: string) {
    validatePinnedImage(imageDigest, this.options.imageAllowlist);
    const runId = randomUUID();
    const resources: { namespace: string; name: string; uid: string }[] = [];
    const make = (): ProvisionJob => ({ ...sandboxIdentity(randomUUID(), 'preflight', 1),
      jobId: randomUUID(), operation: 'provision', imageDigest, seedRef: 'room1-sql-v1', policyRef: 'idan-db-sql@2' });
    const { core, apiOptions } = await this.client();
    const deadline = Date.now() + 60000;
    const wait = async (resource: typeof resources[number]) => {
      while (Date.now() < deadline) {
        const pod = await core.readNamespacedPod({ namespace: resource.namespace, name: resource.name }, apiOptions);
        if (pod.metadata?.uid !== resource.uid || pod.metadata.labels?.['team5.test-run'] !== runId) {
          throw new SandboxExecutionError('ownershipConflict');
        }
        if (pod.status?.phase === 'Running') return pod;
        if (['Failed', 'Succeeded'].includes(pod.status?.phase ?? '')) throw new SandboxExecutionError('runtimeUnavailable');
        await delay(200);
      }
      throw new SandboxExecutionError('runtimeUnavailable');
    };
    try {
      const source = make();
      const created = await this.ensure(source, runId);
      if (!created.metadata?.uid) throw new SandboxExecutionError('ownershipConflict');
      const sourceRef = { namespace: source.namespace, name: source.podName, uid: created.metadata.uid };
      resources.push(sourceRef);
      const target = sqlPod(make(), this.options.runtimeClass);
      target.metadata.labels = { ...target.metadata.labels, 'team5.test-run': runId, 'team5.preflight-target': 'true' };
      target.spec.containers = target.spec.containers.map(container => ({
        ...container, command: ['node', '/opt/sql/query-helper.mjs', 'probe-server'],
      }));
      const control = structuredClone(target);
      control.metadata = { ...control.metadata, namespace: 'team5-sandbox-probes', name: make().podName };
      for (const body of [target, control]) {
        const pod = await core.createNamespacedPod({ namespace: body.metadata.namespace, body }, apiOptions);
        if (!pod.metadata?.uid) throw new SandboxExecutionError('ownershipConflict');
        resources.push({ namespace: body.metadata.namespace, name: body.metadata.name, uid: pod.metadata.uid });
      }
      const sourcePod = await wait(sourceRef);
      const targetPod = await wait(resources[1]);
      const controlPod = await wait(resources[2]);
      if (!sourcePod.status?.hostIP || !targetPod.status?.podIP || !controlPod.status?.podIP) {
        throw new SandboxExecutionError('runtimeUnavailable');
      }
      if (!sourcePod.spec?.nodeName) throw new SandboxExecutionError('isolationFailed');
      const configText = await core.connectGetNodeProxyWithPath({ name: sourcePod.spec.nodeName, path: 'configz' }, apiOptions);
      const nodeConfig: unknown = typeof configText === 'string' ? JSON.parse(configText) : configText;
      if (!subset({ kubeletconfig: { podPidsLimit: 64 } }, nodeConfig)) throw new SandboxExecutionError('isolationFailed');
      const targets = [
        { host: targetPod.status.podIP, port: 18080 },
        { host: '1.1.1.1', port: 443 },
        { host: sourcePod.status.hostIP, port: 10250 },
        { host: controlPod.status.podIP, port: 18080 },
      ];
      let controlReport: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        controlReport = await this.execHelper(control.metadata.namespace, control.metadata.name, 'inspect', { targets });
        if (subset({ reachable: [true, true, true, true] }, controlReport)) break;
        if (attempt < 2) await delay(500);
      }
      if (!subset({ reachable: [true, true, true, true] }, controlReport)) {
        const reachable: unknown = controlReport && typeof controlReport === 'object'
          ? Reflect.get(controlReport, 'reachable') : undefined;
        const names = ['crossSandbox', 'external', 'nodeHost', 'application'];
        const failed = names.filter((_, index) => !Array.isArray(reachable) || reachable[index] !== true);
        this.logger.error(`Sandbox preflight failed: positiveControlUnavailable (${failed.join(',')})`);
        throw new SandboxExecutionError('preflightControlUnavailable');
      }
      let ready = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await this.helper(source, sourceRef.uid, 'ready');
          if (!subset({ version: 1, ready: true, seedRef: 'room1-sql-v1' }, result)) {
            throw new SandboxExecutionError('templateMismatch');
          }
          ready = true;
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await delay(500);
        }
      }
      if (!ready) throw new SandboxExecutionError('notReady');
      const result = await this.helper(source, sourceRef.uid, 'inspect', { targets });
      const expected = { version: 1, uid: 70, gid: 70, readOnlyRoot: true, noCapabilities: true, noNewPrivileges: true,
        pidQuota: true, memory: 256 * 1024 * 1024, cpu: '50000 100000',
        volumes: [56 * 1024 * 1024, 4 * 1024 * 1024, 4 * 1024 * 1024],
        databaseTcp: false, reachable: [false, false, false, false] };
      if (!subset(expected, result)) {
        const failed = Object.entries(expected).filter(([key, value]) => !result || typeof result !== 'object'
          || !subset(value, Reflect.get(result, key))).map(([key]) => key);
        this.logger.error(`Sandbox preflight failed: isolationFailed (${failed.join(',')})`);
        const evidence: unknown = result && typeof result === 'object' ? Reflect.get(result, 'pidQuotaEvidence') : undefined;
        if (evidence && typeof evidence === 'object') {
          const counts = ['current', 'before', 'after', 'children'].map(key => {
            const value: unknown = Reflect.get(evidence, key);
            return `${key}=${typeof value === 'number' && Number.isFinite(value) ? value : 'unknown'}`;
          });
          this.logger.error(`Sandbox PID probe: ${counts.join(',')}`);
        }
        throw new SandboxExecutionError('isolationFailed');
      }
      return { verified: true, developmentOnly: this.options.runtimeClass === 'runc', pids: 64, outputLimit: 65536 };
    } finally {
      const failures: Error[] = [];
      for (const resource of resources.reverse()) {
        try {
          let pod = await core.readNamespacedPod({ namespace: resource.namespace, name: resource.name }, apiOptions);
          if (pod.metadata?.uid !== resource.uid || pod.metadata.labels?.['team5.test-run'] !== runId) {
            throw new SandboxExecutionError('ownershipConflict');
          }
          await core.deleteNamespacedPod({ namespace: resource.namespace, name: resource.name,
            body: { preconditions: { uid: resource.uid }, gracePeriodSeconds: 1 } }, apiOptions);
          const cleanupDeadline = Date.now() + 10000;
          while (true) {
            try { pod = await core.readNamespacedPod({ namespace: resource.namespace, name: resource.name }, apiOptions); }
            catch (error) { if (apiStatus(error, 404)) break; throw error; }
            if (pod.metadata?.uid !== resource.uid || Date.now() >= cleanupDeadline) {
              throw new SandboxExecutionError('ownershipConflict');
            }
            await delay(100);
          }
        } catch (error) {
          if (apiStatus(error, 404)) continue;
          this.logger.error(`Sandbox preflight cleanup pending: ${resource.namespace}/${resource.name} UID ${resource.uid}`);
          failures.push(new SandboxExecutionError('runtimeUnavailable'));
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Sandbox preflight cleanup incomplete');
    }
  }

  private failure(error: unknown): SandboxExecutionError {
    if (error instanceof SandboxExecutionError) return error;
    this.logger.error('Sandbox failure: runtimeUnavailable');
    return new SandboxExecutionError('runtimeUnavailable');
  }
}
