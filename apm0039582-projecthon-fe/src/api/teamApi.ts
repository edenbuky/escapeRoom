export class TeamApiError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    readonly body: unknown,
  ) {
    super(`${status} ${statusText}`);
    this.name = 'TeamApiError';
  }
}

/** Fetches from a team's backend microservice via the /api/<team> ingress route. */
export async function fetchFromTeamApi<T = unknown>(
  apiPath: string,
  endpoint = '/',
  init?: RequestInit,
): Promise<T> {
  const suffix = endpoint === '/' ? '' : endpoint;
  const url =
    suffix && !suffix.startsWith('/')
      ? `${apiPath}/${suffix}`
      : `${apiPath}${suffix}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    ...init,
  });

  if (!response.ok) {
    let body: unknown;
    if (response.headers.get('content-type')?.includes('application/json')) {
      try {
        body = await response.json();
      } catch {}
    }
    throw new TeamApiError(response.status, response.statusText, body);
  }

  const contentType = response.headers.get('content-type') ?? '';
  return (
    contentType.includes('application/json')
      ? await response.json()
      : await response.text()
  ) as T;
}
