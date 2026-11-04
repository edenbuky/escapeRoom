import type { PuzzleInput } from '../contracts/outputs';
import { logger } from './logging/logger';

export type SubmitResult = 'accepted' | { error: 'network' | 'unauthorized' | 'forbidden' | 'notFound' | 'conflict' | 'unavailable' };

export interface AuthTokens {
  accessToken: string; refreshToken: string; expiresIn: number; refreshExpiresAt: string;
  user: { id: string; username: string; displayName: string };
}
export class ApiError extends Error {
  constructor(public readonly status: number) { super(status === 0 ? 'Network unavailable' : `Request failed (${status})`); }
}
export class GameApi {
  private auth: AuthTokens | null = null;
  private readonly listeners = new Set<() => void>();
  private refreshing?: { revision: number; promise: Promise<AuthTokens> };
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  constructor(readonly baseUrl: string, private readonly wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))) {}
  getAuth = () => this.auth;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private setAuth(auth: AuthTokens | null) {
    if (this.timer) clearTimeout(this.timer);
    this.auth = auth;
    if (auth) this.timer = setTimeout(() => { void this.refresh().catch(() => undefined); }, Math.max(1000, (auth.expiresIn - 60) * 1000));
    this.listeners.forEach(listener => listener());
  }
  dispose() {
    ++this.revision;
    if (this.timer) clearTimeout(this.timer);
    this.auth = null;
    this.listeners.clear();
  }
  private assertCurrentRevision(revision: number): void {
    if (revision !== this.revision) throw new ApiError(401);
  }
  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { ...init, credentials: 'omit', cache: 'no-store',
        signal: init.signal ?? AbortSignal.timeout(8000) });
    } catch (error) { if (init.signal?.aborted) throw error; throw new ApiError(0); }
  }
  private async authPost(path: string, body: object) {
    const response = await this.raw(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new ApiError(response.status);
    return response;
  }
  async login(username: string, password: string): Promise<void> {
    const revision = ++this.revision;
    const response = await this.authPost('/auth/login', { username, password });
    const auth = await response.json() as AuthTokens;
    if (revision === this.revision) this.setAuth(auth);
  }
  async signup(username: string, email: string, password: string): Promise<void> {
    await this.authPost('/auth/signup', { username, email, password });
  }
  refresh(): Promise<AuthTokens> {
    const revision = this.revision;
    if (this.refreshing?.revision === revision) return this.refreshing.promise;
    const current = this.auth;
    if (!current) return Promise.reject(new ApiError(401));
    let operation: { revision: number; promise: Promise<AuthTokens> };
    const promise = this.authPost('/auth/refresh', { refreshToken: current.refreshToken })
      .then(response => response.json() as Promise<AuthTokens>)
      .then(auth => {
        this.assertCurrentRevision(revision);
        this.setAuth(auth); return auth;
      })
      .catch(error => { if (revision === this.revision) this.setAuth(null); throw error; })
      .finally(() => { if (this.refreshing === operation) this.refreshing = undefined; });
    operation = { revision, promise };
    this.refreshing = operation;
    return promise;
  }
  async logout(): Promise<void> {
    const current = this.auth;
    ++this.revision;
    this.setAuth(null);
    if (current) await this.authPost('/auth/logout', { refreshToken: current.refreshToken });
  }
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const revision = this.revision;
    const token = this.auth?.accessToken;
    if (!token) throw new ApiError(401);
    const send = (accessToken: string) => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${accessToken}`);
      return this.raw(path, { ...init, headers });
    };
    let response = await send(token);
    if (revision !== this.revision) {
      await response.body?.cancel();
      throw new ApiError(401);
    }
    if (response.status === 401) {
      await response.body?.cancel();
      this.assertCurrentRevision(revision);
      const current = this.auth;
      const auth = current?.accessToken !== token && current ? current : await this.refresh();
      this.assertCurrentRevision(revision);
      response = await send(auth.accessToken);
      if (revision !== this.revision) {
        await response.body?.cancel();
        throw new ApiError(401);
      }
    }
    if (!response.ok) throw new ApiError(response.status);
    return response;
  }
  private async command(path: string, body?: object): Promise<Response> {
    const revision = this.revision;
    const serializedBody = body ? JSON.stringify(body) : undefined;
    for (let attempt = 0; ; attempt++) {
      this.assertCurrentRevision(revision);
      try { return await this.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: serializedBody }); }
      catch (error) {
        this.assertCurrentRevision(revision);
        if (!(error instanceof ApiError) || ![0, 503].includes(error.status) || attempt === 2) throw error;
        await this.wait(250 * 2 ** attempt);
        this.assertCurrentRevision(revision);
      }
    }
  }
  async start(requestId: string): Promise<string> {
    const response = await this.command('/sessions', { scriptSlug: 'escape-room', requestId });
    const { sessionId } = await response.json() as { sessionId: string };
    logger.info('session started', { sessionId });
    return sessionId;
  }
  async postInput(sessionId: string, puzzleKey: string, input: PuzzleInput): Promise<SubmitResult> {
    const commandId = crypto.randomUUID();
    try {
      await this.command(`/sessions/${encodeURIComponent(sessionId)}/puzzles/${encodeURIComponent(puzzleKey)}/inputs`, { commandId, input });
      logger.info('input accepted', { sessionId, commandId, puzzleKey });
      return 'accepted';
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      logger.warn('input failed', { sessionId, commandId, puzzleKey, status });
      const errors: Record<number, Exclude<SubmitResult, string>['error']> = { 401: 'unauthorized', 403: 'forbidden', 404: 'notFound', 409: 'conflict', 503: 'unavailable' };
      return { error: errors[status] ?? 'network' };
    }
  }
  async abandon(sessionId: string) { await this.command(`/sessions/${encodeURIComponent(sessionId)}/abandon`); }
}