import type { PuzzleInput } from '../contracts/outputs';
import { logger } from './logging/logger';
import { clearDrafts } from './device-drafts';

export type SubmitResult = 'accepted' | { error: 'network' | 'unauthorized' | 'forbidden' | 'notFound' | 'conflict' | 'unavailable' };

export interface AuthTokens {
  accessToken: string; refreshToken: string; expiresIn: number; refreshExpiresAt: string;
  user: { id: string; username: string; displayName: string };
}
export class ApiError extends Error {
  constructor(public readonly status: number) { super(status === 0 ? 'Network unavailable' : `Request failed (${status})`); }
}
export function isConnectionFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}
export class GameApi {
  private auth: AuthTokens | null = null;
  private unavailable = false;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private channel?: BroadcastChannel;
  private refreshing?: { revision: number; promise: Promise<AuthTokens> };
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  constructor(readonly baseUrl: string, private readonly wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)), private readonly browser = false) {}
  private async authLock<T>(work: () => Promise<T>): Promise<T> {
    return this.browser && typeof navigator !== 'undefined' && navigator.locks
      ? await navigator.locks.request(`t5-auth:${this.baseUrl}`, work) : await work();
  }
  async restore(): Promise<void> {
    this.disposed = false;
    if (!this.browser) return;
    if (!this.channel && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(`t5-auth:${this.baseUrl}`);
      this.channel.onmessage = event => {
        if (event.data !== 'logout' && event.data !== 'login') return;
        ++this.revision; this.setAuth(null); clearDrafts();
        if (event.data === 'login') void this.restore().catch(() => undefined);
      };
    }
    try { await this.refresh(); }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; }
  }
  getAuth = () => this.auth;
  getUnavailable = () => this.unavailable;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private setUnavailable(value: boolean) {
    if (this.disposed || value === this.unavailable) return;
    this.unavailable = value;
    this.listeners.forEach(listener => listener());
  }
  async checkConnection(): Promise<boolean> {
    try { return (await this.raw('/health')).ok; } catch { return false; }
  }
  private scheduleRefresh(delay: number) {
    const revision = this.revision;
    this.timer = setTimeout(() => {
      void this.refresh().catch(error => {
        if (revision === this.revision && this.auth && isConnectionFailure(error)) this.scheduleRefresh(10000);
      });
    }, delay);
  }
  private setAuth(auth: AuthTokens | null) {
    if (this.timer) clearTimeout(this.timer);
    this.auth = auth;
    if (auth) this.scheduleRefresh(Math.max(1000, (auth.expiresIn - 60) * 1000));
    this.listeners.forEach(listener => listener());
  }
  dispose() {
    this.disposed = true;
    this.channel?.close(); this.channel = undefined;
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
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { ...init, credentials: this.browser ? 'include' : 'omit', cache: 'no-store',
        signal: init.signal ?? AbortSignal.timeout(8000) });
      this.setUnavailable(response.status >= 500);
      return response;
    } catch (error) { if (init.signal?.aborted) throw error; this.setUnavailable(true); throw new ApiError(0); }
  }
  private async authPost(path: string, body: object) {
    const response = await this.raw(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.browser ? { 'X-Skillbreak-Browser': '1' } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) throw new ApiError(response.status);
    return response;
  }
  private async parseAuth(response: Response): Promise<AuthTokens> {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || typeof Reflect.get(value, 'accessToken') !== 'string'
      || !Reflect.get(value, 'accessToken') || typeof Reflect.get(value, 'expiresIn') !== 'number'
      || !Number.isFinite(Reflect.get(value, 'expiresIn')) || typeof Reflect.get(value, 'user') !== 'object'
      || !Reflect.get(value, 'user') || typeof Reflect.get(Reflect.get(value, 'user'), 'id') !== 'string'
      || !Reflect.get(Reflect.get(value, 'user'), 'id')) throw new ApiError(502);
    return value as AuthTokens;
  }
  async login(username: string, password: string): Promise<void> {
    const revision = ++this.revision;
    const response = await this.authLock(() => this.authPost(this.browser ? '/auth/browser/login' : '/auth/login', { username, password }));
    const auth = await this.parseAuth(response);
    if (revision === this.revision) { this.setAuth(auth); this.channel?.postMessage('login'); }
  }
  async signup(username: string, email: string, password: string): Promise<void> {
    await this.authPost('/auth/signup', { username, email, password });
  }
  refresh(): Promise<AuthTokens> {
    const revision = this.revision;
    if (this.refreshing?.revision === revision) return this.refreshing.promise;
    const current = this.auth;
    if (!current && !this.browser) return Promise.reject(new ApiError(401));
    let operation: { revision: number; promise: Promise<AuthTokens> };
    const promise = this.authLock(() => {
      this.assertCurrentRevision(revision);
      return this.authPost(this.browser ? '/auth/browser/refresh' : '/auth/refresh', this.browser ? {} : { refreshToken: current!.refreshToken });
    })
      .then(response => this.parseAuth(response))
      .then(auth => {
        this.assertCurrentRevision(revision);
        this.setAuth(auth); return auth;
      })
      .catch(error => { if (revision === this.revision && error instanceof ApiError && error.status === 401) this.setAuth(null); throw error; })
      .finally(() => { if (this.refreshing === operation) this.refreshing = undefined; });
    operation = { revision, promise };
    this.refreshing = operation;
    return promise;
  }
  async logout(): Promise<void> {
    const current = this.auth;
    ++this.revision;
    this.setAuth(null);
    clearDrafts();
    this.channel?.postMessage('logout');
    if (this.browser) await this.authLock(() => this.authPost('/auth/browser/logout', {}));
    else if (current) await this.authPost('/auth/logout', { refreshToken: current.refreshToken });
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
        if (!(error instanceof ApiError) || ![0, 502, 503, 504].includes(error.status) || attempt === 2) throw error;
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
  async resume(): Promise<string | null> {
    const response = await this.request('/sessions/resume');
    return (await response.json() as { sessionId: string | null }).sessionId;
  }
  async door(sessionId: string, roomKey: string, action: 'open-door' | 'enter'): Promise<void> {
    await this.command(`/sessions/${encodeURIComponent(sessionId)}/rooms/${encodeURIComponent(roomKey)}/${action}`, { commandId: crypto.randomUUID() });
  }
}