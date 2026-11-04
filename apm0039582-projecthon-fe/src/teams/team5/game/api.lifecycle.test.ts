import { GameApi, type AuthTokens } from './api';

const tokens: AuthTokens = {
  accessToken: 'access-one', refreshToken: 'refresh-one', expiresIn: 900, refreshExpiresAt: '',
  user: { id: 'user-one', username: 'player', displayName: 'Player' },
};

function response(body: unknown, status = 200): Response {
  return status === 204 ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe('GameApi auth lifecycle', () => {
  let api: GameApi;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    api = new GameApi('/api/team5');
  });

  afterEach(() => {
    api.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not restore auth or schedule refresh after disposal while login is pending', async () => {
    vi.useFakeTimers();
    const loginResponse = deferred<Response>();
    const listener = vi.fn();
    api.subscribe(listener);
    fetchMock.mockReturnValueOnce(loginResponse.promise);

    const login = api.login('player', 'password');
    api.dispose();
    loginResponse.resolve(response(tokens));
    await login;

    expect(api.getAuth()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-flight refresh from restoring auth after disposal', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(response(tokens));
    await api.login('player', 'password');

    const refreshResponse = deferred<Response>();
    fetchMock.mockReturnValueOnce(refreshResponse.promise);
    const refreshing = api.refresh();
    api.dispose();
    refreshResponse.resolve(response({ ...tokens, accessToken: 'late-token' }));

    await expect(refreshing).rejects.toMatchObject({ status: 401 });
    expect(api.getAuth()).toBeNull();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a delayed 401 with credentials from a later login', async () => {
    const protectedResponse = deferred<Response>();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) {
        const secondLogin = fetchMock.mock.calls.filter(([requestUrl]) => String(requestUrl).endsWith('/auth/login')).length > 1;
        return Promise.resolve(response(secondLogin ? { ...tokens, accessToken: 'access-two',
          refreshToken: 'refresh-two', user: { ...tokens.user, id: 'user-two' } } : tokens));
      }
      if (url.endsWith('/auth/logout')) return Promise.resolve(response(null, 204));
      if (url.endsWith('/protected')) return protectedResponse.promise;
      if (url.endsWith('/auth/refresh')) return Promise.resolve(response({ ...tokens, accessToken: 'unexpected-refresh' }));
      throw new Error(`Unexpected request: ${url}`);
    });

    await api.login('first', 'password');
    const protectedRequest = api.request('/protected');
    await api.logout();
    await api.login('second', 'password');
    protectedResponse.resolve(response({}, 401));

    await expect(protectedRequest).rejects.toMatchObject({ status: 401 });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/protected'))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/refresh'))).toBe(false);
  });

  it('does not retry a command after logout and another login during the backoff', async () => {
    const backoffStarted = deferred<void>();
    const releaseBackoff = deferred<void>();
    const wait = vi.fn(() => {
      backoffStarted.resolve();
      return releaseBackoff.promise;
    });
    api = new GameApi('/api/team5', wait);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) {
        const secondLogin = fetchMock.mock.calls.filter(([requestUrl]) => String(requestUrl).endsWith('/auth/login')).length > 1;
        return Promise.resolve(response(secondLogin ? { ...tokens, accessToken: 'access-two',
          refreshToken: 'refresh-two', user: { ...tokens.user, id: 'user-two' } } : tokens));
      }
      if (url.endsWith('/auth/logout')) return Promise.resolve(response(null, 204));
      if (url.endsWith('/sessions')) return Promise.resolve(response({}, 503));
      throw new Error(`Unexpected request: ${url}`);
    });

    await api.login('first', 'password');
    const start = api.start('stable-request-id');
    await backoffStarted.promise;
    await api.logout();
    await api.login('second', 'password');
    releaseBackoff.resolve();

    await expect(start).rejects.toMatchObject({ status: 401 });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/sessions'))).toHaveLength(1);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('still permits a token refresh and retry within the same login revision', async () => {
    fetchMock.mockResolvedValueOnce(response(tokens));
    await api.login('player', 'password');
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/auth/refresh')) return Promise.resolve(response({ ...tokens, accessToken: 'access-refreshed' }));
      const authorization = new Headers(init?.headers).get('Authorization');
      return Promise.resolve(authorization === 'Bearer access-refreshed' ? response({ ok: true }) : response({}, 401));
    });

    await expect(api.request('/protected')).resolves.toMatchObject({ status: 200 });
    expect(api.getAuth()?.accessToken).toBe('access-refreshed');
  });
});