import { fetchFromTeamApi, TeamApiError } from './teamApi';

afterEach(() => vi.unstubAllGlobals());

describe('shared team transport compatibility', () => {
  it.each([
    ['/', '/api/team7'],
    ['api/events', '/api/team7/api/events'],
    ['/api/events', '/api/team7/api/events'],
  ])('preserves prefix joining for %s', async (endpoint, url) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"status":"ok"}', {
            headers: { 'content-type': 'application/json' },
          }),
        ),
    );
    await expect(fetchFromTeamApi('/api/team7', endpoint)).resolves.toEqual({
      status: 'ok',
    });
    expect(fetch).toHaveBeenCalledWith(url, {
      headers: { Accept: 'application/json' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves text success and RequestInit, without a multipart content-type', async () => {
    const body = new FormData();
    body.append('event', '{"title":"Team"}');
    const signal = new AbortController().signal;
    const init = { method: 'POST', body, signal, headers: { 'X-Test': 'yes' } };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('accepted', { status: 202 })),
    );
    await expect(
      fetchFromTeamApi('/api/team7', '/api/events', init),
    ).resolves.toBe('accepted');
    expect(fetch).toHaveBeenCalledWith('/api/team7/api/events', init);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 413, 415, 500])(
    'exposes HTTP %i and unknown JSON without breaking Error callers or retrying',
    async (status) => {
      const body = {
        statusCode: status,
        code: 'VALIDATION_FAILED',
        fieldErrors: { title: ['Required'], future: ['Invalid'] },
      };
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify(body), {
              status,
              statusText: 'Rejected',
              headers: { 'content-type': 'application/json' },
            }),
          ),
      );
      const error = await fetchFromTeamApi('/api/team7', '/api/events', {
        method: 'POST',
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(TeamApiError);
      expect(error).toMatchObject({
        status,
        body,
        message: `${status} Rejected`,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['text/html', 'application/json'])(
    'uses safe fallback for non-JSON or unreadable %s error bodies',
    async (contentType) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response('private upstream contents', {
              status: 502,
              statusText: 'Bad Gateway',
              headers: { 'content-type': contentType },
            }),
          ),
      );
      const error = await fetchFromTeamApi('/api/team7', '/api/events').catch(
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({
        status: 502,
        body: undefined,
        message: '502 Bad Gateway',
      });
      expect(String(error)).not.toContain('private');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    new TypeError('Network failed'),
    new DOMException('Aborted', 'AbortError'),
  ])('does not retry network/abort failures', async (failure) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
    await expect(
      fetchFromTeamApi('/api/team7', '/api/events', { method: 'POST' }),
    ).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry or hide malformed successful JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('{', {
            headers: { 'content-type': 'application/json' },
          }),
        ),
    );
    await expect(
      fetchFromTeamApi('/api/team7', '/api/events', { method: 'POST' }),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
