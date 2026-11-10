const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '../..');
const available = !spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).error;
const suite = available ? describe : describe.skip;
const args = ['template', 'projecthon-team5', 'projecthon-team5-chart', '-n', 'tdp-2026',
  '-f', 'projecthon-team5-chart/envs/dev.yaml',
  '--set', 'image.repository=example.invalid/backend:1'];

suite('full-stack Kubernetes manifests (requires Helm)', () => {
  let objects;
  beforeAll(() => { objects = yaml.loadAll(execFileSync('helm', args, { cwd: root, encoding: 'utf8' })); });
  const find = (kind, name) => objects.find(item => item.kind === kind && item.metadata.name === name);
  test('deploys only the backend without a duplicate frontend or local PostgreSQL', () => {
    const names = objects.filter(item => item.kind === 'Deployment').map(item => item.metadata.name);
    expect(names).toEqual(['projecthon-team5']);
    expect(objects.some(item => item.kind === 'Namespace' || item.kind === 'PersistentVolumeClaim')).toBe(false);
    expect(JSON.stringify(objects)).not.toMatch(/postgres:|POSTGRES_PASSWORD|kind.*StatefulSet/i);
  });
  test('gates backend on safe migrations and probes both applications without scaling the in-process transport', () => {
    const backend = find('Deployment', 'projecthon-team5');
    expect(backend.spec).toMatchObject({ replicas: 1, strategy: { type: 'Recreate' } });
    const pod = backend.spec.template.spec;
    expect(pod.initContainers[0].args[0]).toContain('node scripts/migrate-shared.js');
    expect(pod.initContainers[0].args[0]).not.toMatch(/drop|reset|revert/i);
    expect(pod.containers[0].command).toEqual(['node', 'scripts/start-deployed.js']);
    expect(pod.containers[0].readinessProbe.exec.command).toEqual(['node', 'scripts/check-deployed-ready.js']);
    expect(pod.containers[0].livenessProbe.tcpSocket.port).toBe('http');
    for (const key of ['DB_USER', 'DB_PASSWORD', 'JWT_ACCESS_SECRET', 'INTERNAL_API_TOKEN']) {
      expect(pod.containers[0].env.find(entry => entry.name === key).valueFrom.secretKeyRef.key).toBe(key);
    }
  });
  test('keeps API and Engine Service ports distinct and sends SSE to Engine without buffering', () => {
    const backendService = find('Service', 'projecthon-team5');
    expect(backendService.spec.ports).toEqual([
      expect.objectContaining({ name: 'http', port: 80, targetPort: 3000 }),
      expect.objectContaining({ name: 'engine', port: 3001, targetPort: 'engine' }),
    ]);
    const stream = find('Ingress', 'projecthon-team5-stream');
    const streamPath = stream.spec.rules[0].http.paths[0];
    const streamMatch = '/api/team5/sessions/uuid/stream'.match(new RegExp(streamPath.path));
    expect(`/${streamMatch[1]}`).toBe('/sessions/uuid/stream');
    expect(streamPath.backend.service.port.number).toBe(3001);
    expect(stream.metadata.annotations['nginx.ingress.kubernetes.io/proxy-buffering']).toBe('off');
    expect(objects.filter(item => item.kind === 'Ingress')).toHaveLength(1);
    expect(objects.some(item => item.kind === 'Deployment' && item.metadata.name === 'projecthon-team5-frontend')).toBe(false);
  });
  test('synchronizes both runtime keys from Key Vault without duplicate environment entries', () => {
    const provider = find('SecretProviderClass', 'projecthon-team5-spc');
    const runtime = provider.spec.secretObjects.filter(entry => entry.secretName === 'projecthon-team5-runtime');
    expect(runtime).toHaveLength(1);
    expect(runtime[0].data).toEqual([
      { objectName: 'projecthon-team5-jwt-access-secret', key: 'JWT_ACCESS_SECRET' },
      { objectName: 'projecthon-team5-internal-api-token', key: 'INTERNAL_API_TOKEN' },
    ]);
    const pod = find('Deployment', 'projecthon-team5').spec.template.spec;
    for (const container of [...pod.initContainers, ...pod.containers]) {
      for (const key of ['JWT_ACCESS_SECRET', 'INTERNAL_API_TOKEN']) {
        const entries = container.env.filter(entry => entry.name === key);
        expect(entries).toHaveLength(1);
        expect(entries[0].valueFrom.secretKeyRef).toMatchObject({
          name: 'projecthon-team5-runtime', key,
        });
        expect(entries[0].valueFrom.secretKeyRef.optional).not.toBe(true);
      }
    }
    const dev = yaml.loadAll(execFileSync('helm', args, {
      cwd: root, encoding: 'utf8',
    }));
    const backend = dev.find(entry => entry.kind === 'Deployment' && entry.metadata.name === 'projecthon-team5');
    for (const key of ['JWT_ACCESS_SECRET', 'INTERNAL_API_TOKEN']) {
      expect(backend.spec.template.spec.containers[0].env.filter(entry => entry.name === key)).toHaveLength(1);
    }
  });
  test('refuses horizontal scaling or competing migration mechanisms', () => {
    for (const override of ['replicaCount=2', 'autoscaling.enabled=true', 'migrations.enabled=true']) {
      const result = spawnSync('helm', [...args, '--set', override], { cwd: root, encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/requires one backend|disable the separate migration Job/);
    }
  });
});
