import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GameApp from './GameApp';
import { fakeViews } from './dev/fakeViews';
import { ROOM_2_ASSETS } from './room-design/room-assets';
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
  let deferResume: (() => Promise<Response>) | undefined;
  let refreshStatus: number;
  let expiresIn: number;
  let signedIn: boolean;
  let resumedSession: string | null;
  const send = (view: SessionView) => stream!.enqueue(new TextEncoder().encode(
    `event: session\nid: ${view.version}\ndata: ${JSON.stringify(view)}\n\n`));
  beforeEach(() => {
    views = fakeViews(); startUnavailable = false; deferStart = undefined; refreshStatus = 200; expiresIn = 900;
    signedIn = false; resumedSession = null; deferResume = undefined;
    sessionStorage.removeItem('t5-background-music');
    fetchMock.mockReset().mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/signup') || url.endsWith('/auth/browser/logout') || url.endsWith('/abandon')) return json({});
      if (url.endsWith('/auth/browser/login')) { signedIn = true; return json({ ...tokens, expiresIn }); }
      if (url.endsWith('/auth/browser/refresh')) return json(tokens, signedIn ? refreshStatus : 401);
      if (url.endsWith('/sessions/resume')) return deferResume ? deferResume() : json({ sessionId: resumedSession });
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
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'player' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password-long-enough' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); });
    expect(screen.getByRole('button', { name: 'Start game' })).toBeInTheDocument();
  }
  it('uses the looping background video and soundtrack across the sign-in screen', async () => {
    const { container } = render(<GameApp apiBase="/api/team5" />);
    expect(await screen.findByText('enter the virtual escape room.')).toBeInTheDocument();
    expect(screen.getByAltText('SkillBreak')).toHaveAttribute('src', expect.stringContaining('Logo-SkillBreak-white-background.png'));
    expect(container.querySelector('video')).toHaveAttribute('src', expect.stringContaining('skillbreak_animated_background.mov'));
    expect(container.querySelector('video')).toHaveAttribute('loop');
    expect((container.querySelector('video') as HTMLVideoElement).muted).toBe(true);
    expect(container.querySelector('audio')).toHaveAttribute('src', expect.stringContaining('game-sound.mp3'));
    expect(container.querySelector('audio')).toHaveAttribute('loop');
    const soundButton = screen.getByRole('button', { name: 'Play background music' });
    expect(soundButton).toHaveClass('t5-icon');
    expect(soundButton.querySelector('svg path')?.getAttribute('d')).toContain('M11 5 6 9');
  });
  it('starts background music only from the music button', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    try {
      render(<GameApp apiBase="/api/team5" />);
      await act(async () => { fireEvent.pointerDown(await screen.findByLabelText('Username')); });
      expect(play).not.toHaveBeenCalled();
      await login();
      expect(play).not.toHaveBeenCalled();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Play background music' })); });
      expect(play).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem('t5-background-music')).toBe('on');
      const muteButton = screen.getByRole('button', { name: 'Mute background music' });
      expect(muteButton).toHaveClass('t5-sound-toggle');
      expect(muteButton.querySelector('svg')).toBeInTheDocument();
      expect(muteButton.closest('.topbar')).toBeInTheDocument();
      fireEvent.click(muteButton);
      expect(screen.getByRole('button', { name: 'Play background music' }).querySelector('svg')).toBeInTheDocument();
      expect(sessionStorage.getItem('t5-background-music')).toBe('off');
    } finally { play.mockRestore(); }
  });
  it('does not start music on page load, even if it was on before a refresh', async () => {
    sessionStorage.setItem('t5-background-music', 'on');
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    try {
      render(<GameApp apiBase="/api/team5" />);
      expect(await screen.findByRole('button', { name: 'Play background music' })).toHaveAttribute('aria-pressed', 'false');
      expect(play).not.toHaveBeenCalled();
    } finally { play.mockRestore(); }
  });
  it('signs up, signs in, starts, receives readiness, opens a hotspot, leaves and signs out', async () => {
    render(<GameApp apiBase="/api/team5" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create an account' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'player' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'player@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password-long-enough' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Account created. Sign in to continue.')).toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls.find(([url]) => url.endsWith('/auth/signup'))![1].body)).toEqual({ username: 'player', email: 'player@example.test', password: 'test-password-long-enough' });
    await login();
    expect(document.querySelector('.t5-start-scene > .t5-entry-logo')).toHaveAttribute('src', expect.stringContaining('Logo-SkillBreak-white-background.png'));
    expect(document.querySelector('.topbar .t5-brand-logo')).not.toBeInTheDocument();
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
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/auth/browser/refresh'))).toHaveLength(2);
  });
  it('shows sign-in after logout during resume and ignores the delayed session response', async () => {
    signedIn = true;
    let resolveResume!: (response: Response) => void;
    deferResume = () => new Promise(resolve => { resolveResume = resolve; });
    render(<GameApp apiBase="/api/team5" />);
    await waitFor(() => expect(resolveResume).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    await act(async () => { resolveResume(json({ sessionId: views.starting.sessionId })); });
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(0);
  });
  it('keeps signup and its inputs available while restoring automatically after an outage', async () => {
    vi.useFakeTimers();
    fetchMock.mockReset().mockRejectedValue(new Error('offline'));
    const { container } = render(<GameApp apiBase="/api/team5" />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/Cannot reach the server/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'offline-player' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'player@example.test' } });
    expect(container.querySelector('.t5-background-video')).toHaveAttribute('src', expect.stringContaining('skillbreak_animated_background.mov'));
    fetchMock.mockResolvedValue(json({}, 401));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByText(/Cannot reach the server/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toHaveValue('offline-player');
    expect(screen.getByLabelText('Email')).toHaveValue('player@example.test');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
  });
  it('restores cookie authentication and the existing game without sending StartSession', async () => {
    signedIn = true; resumedSession = views.starting.sessionId;
    render(<GameApp apiBase="/api/team5" />);
    expect(await screen.findByText('Sandbox starting')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/sessions'))).toHaveLength(0);
    expect(screen.getByAltText('SkillBreak')).toHaveAttribute('src', expect.stringContaining('Logo-SkillBreak-white-background.png'));
  });
  it('retries session resume after a gateway outage without creating another game', async () => {
    vi.useFakeTimers(); signedIn = true;
    deferResume = async () => json({}, 503);
    render(<GameApp apiBase="/api/team5" />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/Cannot reach the server/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start game' })).toBeDisabled();
    deferResume = undefined; resumedSession = views.starting.sessionId;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('Sandbox starting')).toBeInTheDocument();
    expect(screen.queryByText(/Cannot reach the server/)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/sessions'))).toHaveLength(0);
  });
  it('keeps the start screen after resuming an abandoned session', async () => {
    signedIn = true; resumedSession = views.starting.sessionId;
    views.starting = { ...views.starting, status: 'Abandoned' };
    render(<GameApp apiBase="/api/team5" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start game' })).toBeEnabled());
    expect(screen.queryByText('Game abandoned')).not.toBeInTheDocument();
  });
  it('shows Game Over for a resumed expired game and returns only on explicit action', async () => {
    signedIn = true; resumedSession = views.starting.sessionId;
    views.starting = { ...views.starting, status: 'Expired' };
    render(<GameApp apiBase="/api/team5" />);
    expect(await screen.findByText('Game Over')).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Return to game start' }));
    expect(screen.getByRole('button', { name: 'Start game' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/sessions'))).toHaveLength(0);
  });
  it('shows the victory screen for a resumed escaped game, clears drafts and returns only on explicit action', async () => {
    signedIn = true; resumedSession = views.starting.sessionId;
    views.starting = { ...views.room2Escaped, sessionId: views.starting.sessionId };
    localStorage.setItem(`t5-draft:test-owner:${views.starting.sessionId}:door-code`, '4000');
    const { container } = render(<GameApp apiBase="/api/team5" />);
    expect(await screen.findByText('🎉 Welcome to the team!')).toBeInTheDocument();
    expect(screen.queryByText('Game Over')).not.toBeInTheDocument();
    expect(container.querySelector('.stage[data-room="victory"] img.room-bg')).toHaveAttribute('src', ROOM_2_ASSETS.victory);
    expect(screen.getByText('ROOM 03 · MISSION COMPLETE')).toBeInTheDocument();
    expect(localStorage.getItem(`t5-draft:test-owner:${views.starting.sessionId}:door-code`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Return to game start' }));
    expect(screen.getByRole('button', { name: 'Start game' })).toBeInTheDocument();
  });
});
