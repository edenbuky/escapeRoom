import { randomBytes, randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { SessionStreamGuard } from '../src/modules/projection/session-stream.guard';
import { ProjectionHarness } from './helpers/projection-harness';

const harness = new ProjectionHarness();
test('accepts gateway-shaped claims without an account database', () => {
  const owner = randomUUID();
  expect(new SessionStreamGuard(harness.config).verify(`Bearer ${harness.token(owner)}`)).toMatchObject({ subject: owner });
});
test('fails closed without configuration and rejects invalid credentials', () => {
  expect(() => new SessionStreamGuard({ ...harness.config, jwt: undefined }).verify('')).toThrow('projection_unavailable');
  const guard = new SessionStreamGuard(harness.config);
  for (const header of [undefined, '', 'Basic value', 'Bearer invalid']) expect(() => guard.verify(header)).toThrow();
});
test.each([
  { sub: 'bad' }, { fid: 'bad' }, { ver: -1 }, { exp: Math.floor(Date.now() / 1000) },
  { aud: 'wrong' }, { iss: 'wrong' }, { iat: Math.floor(Date.now() / 1000) + 10 },
  { exp: Math.floor(Date.now() / 1000) + 1000 },
])('rejects invalid claim shape %j', override => {
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign({ sub: randomUUID(), fid: randomUUID(), ver: 0, iat: now, exp: now + 900,
    aud: 'escape-room-client', iss: 'escape-room-api', ...override }, harness.secret);
  expect(() => new SessionStreamGuard(harness.config).verify(`Bearer ${token}`)).toThrow();
});
test('rejects wrong secret and algorithm', () => {
  for (const token of [
    jwt.sign({ sub: randomUUID() }, randomBytes(32)),
    jwt.sign({ sub: randomUUID() }, harness.secret, { algorithm: 'HS384' }),
  ]) expect(() => new SessionStreamGuard(harness.config).verify(`Bearer ${token}`)).toThrow();
});
