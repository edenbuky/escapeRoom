import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PuzzleInput } from '../../../contracts/outputs';
import type { PuzzleView, SessionView } from '../../../contracts/view';
import { fakeViews } from '../../dev/fakeViews';
import type { SubmitResult } from '../types';
import { gitSandboxState, NathanelGitScreen } from './NathanelGitScreen';

const terminals: FakeTerminal[] = [];
class FakeTerminal {
  options: unknown;
  written: string[] = [];
  data: (data: string) => void = () => {};
  open = vi.fn(); loadAddon = vi.fn(); focus = vi.fn(); dispose = vi.fn(); clear = vi.fn();
  hasSelection = () => false; getSelection = () => '';
  attachCustomKeyEventHandler = vi.fn();
  constructor(options: unknown) { this.options = options; terminals.push(this); }
  write(text: string) { this.written.push(text); }
  writeln(text: string) { this.written.push(`${text}\r\n`); }
  onData(listener: (data: string) => void) { this.data = listener; return { dispose: vi.fn() }; }
  get screen() { return this.written.join(''); }
}
const fit = vi.fn();
vi.mock('../../../vendor/xterm', () => ({ Terminal: FakeTerminal, FitAddon: class { fit = fit; activate() {} dispose() {} } }));

const submit = vi.fn<(input: PuzzleInput) => Promise<SubmitResult>>();
const git = (view: SessionView): PuzzleView => view.currentRoom.puzzles[0];
const renderScreen = (view: SessionView, close = vi.fn()) => {
  const ui = (next: SessionView) => <NathanelGitScreen puzzle={git(next)} view={next} submit={submit} close={close} />;
  const rendered = render(ui(view));
  return { ...rendered, update: (next: SessionView) => rendered.rerender(ui(next)), close };
};
const opened = () => waitFor(() => expect(terminals.length).toBeGreaterThan(0));
const type = (term: FakeTerminal, line: string) => act(async () => { for (const char of line) term.data(char); term.data('\r'); });

beforeEach(() => { terminals.length = 0; submit.mockReset().mockResolvedValue('accepted'); fit.mockClear(); });

describe('Nathanel git terminal screen', () => {
  it('has the design window: back button, window name, subtitle, terminal host and footer', async () => {
    const { container } = renderScreen(fakeViews().room2GitReady);
    await opened();
    expect(screen.getByRole('button', { name: "← Nathanel's computer" })).toBeInTheDocument();
    expect(screen.getByText('⌘ Netanel · Git terminal · project_cibus_payment')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Git sandbox · Ready');
    expect(container.querySelector('.window-shell.terminal-window > .terminal-host')).not.toBeNull();
    expect(container.querySelector('.window-footer')).toHaveTextContent('Type help');
    expect([...container.querySelector('.window-shell')!.children].map(child => child.className))
      .toEqual(['window-header', 'window-subtitle', 'terminal-host', 'window-footer']);
  });

  it('creates xterm with the design options and theme, fits it, and prints the intro and prompt', async () => {
    renderScreen(fakeViews().room2GitReady);
    await opened();
    const [term] = terminals;
    expect(term.options).toEqual({ cursorBlink: true, scrollback: 500, convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 14,
      theme: { background: '#080e18', foreground: '#d9f2ff', cursor: '#6ee7ff', selectionBackground: '#2864a977' } });
    expect(term.open).toHaveBeenCalled();
    expect(fit).toHaveBeenCalled();
    expect(term.screen).toContain('\x1b[36mNetanel Workstation — project history\x1b[0m');
    expect(term.screen).toContain('\x1b[36mType help, or try: git log --oneline\x1b[0m');
    expect(term.screen.endsWith('netanel@tdp:~/project_cibus_payment$ ')).toBe(true);
    await waitFor(() => expect(term.focus).toHaveBeenCalled());
  });

  it('goes back to the desktop with the back button', async () => {
    const { close } = renderScreen(fakeViews().room2GitReady);
    await opened();
    fireEvent.click(screen.getByRole('button', { name: "← Nathanel's computer" }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('submits a command and prints the result the view brings back, including a solved one', async () => {
    const views = fakeViews();
    const { update } = renderScreen(views.room2GitReady);
    await opened();
    const [term] = terminals;
    await type(term, 'git show HEAD~1:server.key');
    expect(submit).toHaveBeenCalledWith({ kind: 'command', command: 'git show HEAD~1:server.key' });
    const solved = structuredClone(views.room2GitReady);
    git(solved).latestResult = { commandId: 'cmd-1', verdict: 'solved', reason: null, output: '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n' };
    solved.latestResult = git(solved).latestResult;
    git(solved).status = 'solved';
    update(solved);
    expect(term.screen).toContain('-----BEGIN RSA PRIVATE KEY-----\r\nMIIE\r\n-----END RSA PRIVATE KEY-----\r\n');
    expect(term.screen.endsWith('$ ')).toBe(true);
  });

  it('shows "Command not allowed" for a blocked command', async () => {
    const views = fakeViews();
    const { update } = renderScreen(views.room2GitReady);
    await opened();
    await type(terminals[0], 'vim');
    const blocked = structuredClone(views.room2GitReady);
    git(blocked).latestResult = { commandId: 'cmd-2', verdict: 'rejected', reason: 'policyBlocked', output: '' };
    blocked.latestResult = git(blocked).latestResult;
    update(blocked);
    expect(terminals[0].screen).toContain('Command not allowed');
  });

  it('prints an engine-level rejection that only the view\'s latest result carries (not the puzzle\'s)', async () => {
    const views = fakeViews();
    const { update } = renderScreen(views.room2GitReady);
    await opened();
    await type(terminals[0], 'git log');
    const locked = structuredClone(views.room2GitReady);
    locked.latestResult = { commandId: 'cmd-3', verdict: 'rejected', reason: 'sandboxRestarting', output: 'Sandbox state changed. Retry with a new command.' };
    update(locked);
    expect(terminals[0].screen).toContain('Sandbox state changed. Retry with a new command.');
    expect(terminals[0].screen).not.toContain('No result received yet');
  });

  it('on a reset shows the notice, clears the scrollback, locks input until the new sandbox is ready, then a fresh intro', async () => {
    const views = fakeViews();
    const { update } = renderScreen(views.room2GitReady);
    await opened();
    const [term] = terminals;
    await type(term, 'git commit --allow-empty -m x');
    const ruined = structuredClone(views.room2GitReady);
    ruined.latestResult = { commandId: 'cmd-4', verdict: 'ruined', reason: null, output: '[main abc1234] x\n' };
    git(ruined).latestResult = ruined.latestResult;
    git(ruined).sandbox = { generation: 2, status: 'provisioning' };
    update(ruined);
    expect(term.clear).toHaveBeenCalledTimes(1);
    expect(term.screen).toContain('Puzzle reset – sandbox restarting');
    expect(term.screen).not.toContain('abc1234');
    expect(screen.getByRole('status')).toHaveTextContent('Git sandbox · Sandbox restarting');
    submit.mockClear();
    await type(term, 'git log');
    expect(submit).not.toHaveBeenCalled();
    const ready = structuredClone(ruined);
    git(ready).sandbox = { generation: 2, status: 'ready' };
    update(ready);
    expect(term.screen.endsWith('Type help, or try: git log --oneline\x1b[0m\r\nnetanel@tdp:~/project_cibus_payment$ ')).toBe(true);
    await type(term, 'git log');
    expect(submit).toHaveBeenCalledWith({ kind: 'command', command: 'git log' });
  });

  it('does not send while the sandbox starts, and shows the state in the subtitle', async () => {
    renderScreen(fakeViews().room2);
    await opened();
    expect(screen.getByRole('status')).toHaveTextContent('Git sandbox · Sandbox starting');
    await type(terminals[0], 'git log');
    expect(submit).not.toHaveBeenCalled();
    expect(terminals[0].screen).toContain('Sandbox starting. Try again in a moment.');
  });

  it('follows the sandbox status of the view while the window stays open', async () => {
    const views = fakeViews();
    const { update } = renderScreen(views.room2);
    await opened();
    update(views.room2GitReady);
    expect(screen.getByRole('status')).toHaveTextContent('Git sandbox · Ready');
    await type(terminals[0], 'ls');
    expect(submit).toHaveBeenCalledWith({ kind: 'command', command: 'ls' });
    const failed = structuredClone(views.room2GitReady);
    git(failed).sandbox.status = 'failed';
    update(failed);
    expect(screen.getByRole('status')).toHaveTextContent('Git sandbox · Sandbox failed');
  });

  it('disposes the terminal when the window closes', async () => {
    const { unmount } = renderScreen(fakeViews().room2GitReady);
    await opened();
    unmount();
    expect(terminals[0].dispose).toHaveBeenCalled();
  });

  it('classifies the sandbox like the room status line', () => {
    const base = fakeViews().room2GitReady.currentRoom.puzzles[0];
    const state = (sandbox: PuzzleView['sandbox'], latestResult: PuzzleView['latestResult'] = null) => gitSandboxState({ ...base, sandbox, latestResult });
    expect(state({ generation: 1, status: 'ready' })).toBe('ready');
    expect(state({ generation: 1, status: 'provisioning' })).toBe('starting');
    expect(state({ generation: 2, status: 'provisioning' })).toBe('restarting');
    expect(state({ generation: 1, status: 'provisioning' }, { commandId: 'x', verdict: 'rejected', reason: 'sandboxRestarting', output: '' })).toBe('restarting');
    expect(state({ generation: 1, status: 'failed' })).toBe('failed');
  });
});
