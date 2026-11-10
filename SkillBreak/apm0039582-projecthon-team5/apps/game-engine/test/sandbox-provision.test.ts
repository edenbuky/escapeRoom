import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOM1 } from '../src/modules/script-catalog/room1';
import { randomUUID } from 'node:crypto';
import { sandboxIdentity } from '../src/modules/sessions/core/ids';
import { assertOwnedPod, sqlPod, validatePinnedImage } from '../src/modules/sandbox/kubernetes-driver';

const image = resolve(__dirname, '../../../sandboxes/sql');
test('fixture projects only the fictional username/hash, not plaintext answers or application data', () => {
  const fixture = readFileSync(resolve(image, 'fixtures/room1-sql-v1.sql'), 'utf8');
  expect(fixture).toContain(ROOM1.danaUsername);
  expect(fixture).toContain(ROOM1.danaPasswordSha256);
  expect(fixture).not.toContain(ROOM1.danaPassword);
  expect(fixture).toContain('CREATE TABLE employees');
  expect(fixture).toContain('CREATE TABLE logs');
  expect(fixture).toContain('GRANT SELECT ON employees, logs TO sandbox_player');
  expect(fixture).toContain('REVOKE TEMPORARY');
  expect(fixture).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION');
});

test('image is non-root, manifest-pinned and uses only a Unix-socket PostgreSQL listener', () => {
  const dockerfile = readFileSync(resolve(image, 'Dockerfile'), 'utf8');
  expect(dockerfile).toMatch(/FROM node:22-alpine@sha256:[0-9a-f]{64}/);
  expect(dockerfile).toMatch(/FROM postgres:16-alpine@sha256:[0-9a-f]{64}/);
  expect(dockerfile).toContain('USER 70:70');
  const entrypoint = readFileSync(resolve(image, 'entrypoint.sh'), 'utf8');
  expect(entrypoint).toContain("listen_addresses=''");
  expect(entrypoint).toContain('--wal-segsize=1');
  expect(entrypoint).toContain('Existing PostgreSQL data is incomplete');
});

const request = { ...sandboxIdentity(randomUUID(), 'idan-db', 1), jobId: randomUUID(), operation: 'provision' as const,
  imageDigest: `localhost:5001/room1-sql@sha256:${'a'.repeat(64)}`, seedRef: 'room1-sql-v1', policyRef: 'idan-db-sql@2' };
test('requires a manifest digest from the exact engine-owned repository allowlist', () => {
  expect(validatePinnedImage(request.imageDigest, ['localhost:5001/room1-sql'])).toBe(request.imageDigest);
  for (const image of ['local/room1-sql:dev', request.imageDigest.replace('room1-sql', 'other'), request.imageDigest.toUpperCase()]) {
    expect(() => validatePinnedImage(image, ['localhost:5001/room1-sql'])).toThrow('immutable image');
  }
});

test('pod controls are real Kubernetes fields, with exactly 64 MiB total memory-backed writable volumes', () => {
  const pod = sqlPod(request, 'runc');
  expect(pod.spec).toMatchObject({ runtimeClassName: 'runc', automountServiceAccountToken: false,
    enableServiceLinks: false, hostNetwork: false, hostPID: false, hostIPC: false,
    securityContext: { runAsNonRoot: true, runAsUser: 70, runAsGroup: 70, fsGroup: 70 } });
  expect(pod.spec.containers[0]).toMatchObject({ image: request.imageDigest,
    resources: { limits: { memory: '256Mi', cpu: '500m' } },
    securityContext: { allowPrivilegeEscalation: false, privileged: false, readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] } } });
  expect(pod.spec.volumes.map(volume => volume.emptyDir)).toEqual([
    { medium: 'Memory', sizeLimit: '56Mi' }, { medium: 'Memory', sizeLimit: '4Mi' }, { medium: 'Memory', sizeLimit: '4Mi' },
  ]);
});

test('adoption rejects mismatched UID, image, labels, mounts and relaxed security controls', () => {
  const expected = sqlPod(request, 'runc');
  const pod = { ...expected, metadata: { ...expected.metadata, uid: 'owned' } };
  expect(() => assertOwnedPod(request, 'runc', pod, 'owned')).not.toThrow();
  expect(() => assertOwnedPod(request, 'runc', pod, 'other')).toThrow('ownership');
  const mutations = [
    { ...pod, metadata: { ...pod.metadata, labels: {} } },
    { ...pod, spec: { ...pod.spec, hostNetwork: true } },
    { ...pod, spec: { ...pod.spec, containers: [{ ...pod.spec.containers[0], image: 'untrusted:tag' }] } },
    { ...pod, spec: { ...pod.spec, volumes: [...pod.spec.volumes, { name: 'host', hostPath: { path: '/' } }] } },
  ];
  for (const changed of mutations) expect(() => assertOwnedPod(request, 'runc', changed, 'owned')).toThrow('ownership');
});
