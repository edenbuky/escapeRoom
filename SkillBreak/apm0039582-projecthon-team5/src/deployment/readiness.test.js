const { check } = require('../../scripts/check-deployed-ready');
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

test('requires both backend health endpoints and connected authenticated projection', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () =>
    ({ messaging: 'connected', projection: { live: true } }) });
  await expect(check()).resolves.toBeUndefined();
  expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
    'http://127.0.0.1:3000/health', 'http://127.0.0.1:3001/health',
  ]);
});
test.each([
  [{ ok: false }, 'health'],
  [{ ok: true, json: async () => ({ messaging: 'not_connected', projection: { live: true } }) }, 'messaging'],
  [{ ok: true, json: async () => ({ messaging: 'connected', projection: { live: false } }) }, 'projection'],
])('fails closed before routing traffic to an unavailable backend', async (response, message) => {
  global.fetch = jest.fn().mockResolvedValue(response);
  await expect(check()).rejects.toThrow(message);
});
