import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GameApp from './GameApp';
import { fakeViews } from './dev/fakeViews';
import type { SessionView } from '../contracts/view';

const tokens = { accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 900, refreshExpiresAt: '',
  user: { id: 'test-owner', username: 'player', displayName: 'Player' } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('game shell with controlled HTTP and SSE', () => {
  const fetchMock = vi.fn();
  let views: ReturnType<typeof fakeViews>;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let startUnavailable: boolean;
  let deferStart: (() => Promise<Response>) | undefined;
  let refreshStatus: number;
  let expiresIn: number;
  const send = (view: SessionView) => stream!.enqueue(new TextEncoder().encode(
    `event: session\nid: ${view.version}\ndata: ${JSON.stringify(view)}\n\n`));
  beforeEach(() => {
    views = fakeViews(); startUnavailable = false; deferStart = undefined; refreshStatus = 200; expiresIn = 900;
    fetchMock.mockReset().mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/signup') || url.endsWith('/auth/logout') || url.endsWith('/abandon')) return json({});
      if (url.endsWith('/auth/login')) return json({ ...tokens, expiresIn });
      if (url.endsWith('/auth/refresh')) return json(tokens, refreshStatus);
      if (url.endsWith('/sessions')) return deferStart ? deferStart() : json({ sessionId: views.starting.sessionId }, startUnavailable ? 503 : 202);
      if (url.endsWith('/stream')) return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller; send(views.starting);
        init.signal?.addEventListener('abort', () => { controller.close(); if (stream === controller) stream = undefined; }, { once: true });
      } }), { headers: { 'Content-Type': 'text/event-stream', Date: new Date(Date.parse(views.starting.deadlineAt) - 45 * 60 * 1000).toUTCString() } });
      throw new Error(`Unexpected test request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  async function login() {
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'player' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password-long-enough' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); });
    expect(screen.getByRole('button', { name: 'Start game' })).toBeInTheDocument();
  }
  it('signs up, signs in, starts, receives readiness, opens a hotspot, leaves and signs out', async () => {
    render(<GameApp apiBase="/api/team5" />);
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'player' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'player@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password-long-enough' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Account created. Sign in to continue.')).toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ username: 'player', email: 'player@example.test', password: 'test-password-long-enough' });
    await login();
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
    expect(await screen.findByText('Sandbox starting')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/^45:0[01]$/);
    expect(screen.getByText("Dana's room").closest('header')).toContainElement(screen.getByRole('timer'));
    expect(screen.getByRole('button', { name: 'Hash Cracker (locked)' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => { send(views.ready); });
    expect(screen.getByText('Ready')).toBeInTheDocument();
    const streamRequest = fetchMock.mock.calls.find(([url]) => url.endsWith('/stream'))!;
    expect(streamRequest[0]).not.toContain(tokens.accessToken);
    expect(new Headers(streamRequest[1].headers).get('Authorization')).toBe(`Bearer ${tokens.accessToken}`);
    fireEvent.click(screen.getByRole('button', { name: "Idan's computer · SQL" }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Screen unavailable');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Leave game' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/abandon'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Leave game' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave game' }));
    expect(await screen.findByRole('button', { name: 'Start game' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it('shows start failures and preserves the request ID when the player retries', async () => {
    startUnavailable = true;
    render(<GameApp apiBase="/api/team5" />); await login();
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('Game service unavailable');
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    startUnavailable = false;
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
    expect(await screen.findByText('Sandbox starting')).toBeInTheDocument();
    const starts = fetchMock.mock.calls.filter(([url]) => url.endsWith('/sessions'));
    expect(starts).toHaveLength(4);
    expect(new Set(starts.map(([, init]) => JSON.parse(init.body).requestId)).size).toBe(1);
  });
  it('ignores a successful start response arriving after sign-out', async () => {
    let resolveStart!: (response: Response) => void;
    deferStart = () => new Promise(resolve => { resolveStart = resolve; });
    render(<GameApp apiBase="/api/team5" />); await login();
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
    await waitFor(() => expect(resolveStart).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await act(async () => { resolveStart(json({ sessionId: views.starting.sessionId }, 202)); });
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(0);
  });
  it('returns to sign-in when scheduled refresh is rejected', async () => {
    vi.useFakeTimers(); expiresIn = 61; refreshStatus = 401;
    render(<GameApp apiBase="/api/team5" />); await login();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/auth/refresh'))).toHaveLength(1);
  });
});