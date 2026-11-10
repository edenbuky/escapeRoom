import type { EvaluationView } from '../../../contracts/view';
import type { XTerm } from '../../../vendor/xterm';
import type { SubmitResult } from '../types';
import { createGitTerminal, INTRO, MAX_COMMAND_CHARS, PROMPT, RESET_NOTICE, type GitSandboxState } from './git-terminal';

/** A stand-in for xterm.js: records what is written and lets the test type into it. */
function fakeTerm() {
  let listener: (data: string) => void = () => {};
  let keyHandler: (event: KeyboardEvent) => boolean = () => true;
  const written: string[] = [];
  const term = {
    element: undefined, open: vi.fn(), loadAddon: vi.fn(), dispose: vi.fn(), focus: vi.fn(),
    write: vi.fn((data: string) => { written.push(data); }),
    writeln: vi.fn((data: string) => { written.push(`${data}\r\n`); }),
    clear: vi.fn(),
    hasSelection: vi.fn(() => false), getSelection: vi.fn(() => ''),
    onData: vi.fn((next: (data: string) => void) => { listener = next; return { dispose: vi.fn() }; }),
    attachCustomKeyEventHandler: vi.fn((handler: (event: KeyboardEvent) => boolean) => { keyHandler = handler; }),
  };
  return { term: term as unknown as XTerm & typeof term, written, type: (data: string) => listener(data), key: (event: Partial<KeyboardEvent>) => keyHandler(event as KeyboardEvent),
    typeLine: (line: string) => { for (const char of line) listener(char); listener('\r'); },
    screen: () => written.join('') };
}

const result = (commandId: string, output: string, verdict: 'progress' | 'solved' = 'progress'): EvaluationView =>
  ({ commandId, verdict, reason: null, output });
const rejected = (commandId: string, reason: Extract<EvaluationView, { verdict: 'rejected' }>['reason'], output = ''): EvaluationView =>
  ({ commandId, verdict: 'rejected', reason, output });

function setup(options: { sandbox?: GitSandboxState; reply?: SubmitResult | Error } = {}) {
  const fake = fakeTerm();
  const host = document.createElement('div');
  document.body.append(host);
  const send = vi.fn(async (_command: string): Promise<SubmitResult> => {
    if (options.reply instanceof Error) throw options.reply;
    return options.reply ?? 'accepted';
  });
  let sandbox: GitSandboxState = options.sandbox ?? 'ready';
  let id: string | null = 'first';
  const terminal = createGitTerminal({ term: fake.term, host, sandbox: () => sandbox, send, resultId: () => id });
  return { ...fake, host, send, terminal, setSandbox: (next: GitSandboxState) => { sandbox = next; } };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('git terminal line editor', () => {
  it('prints the cyan intro lines and the prompt', () => {
    const { written } = setup();
    expect(written.slice(0, 2)).toEqual(INTRO.map(line => `\x1b[36m${line}\x1b[0m\r\n`));
    expect(written[2]).toBe(PROMPT);
    expect(PROMPT).toBe('netanel@tdp:~/project_cibus_payment$ ');
  });

  it('sends each Enter as one command and prints only what the session view returns', async () => {
    const t = setup();
    t.typeLine('git log --oneline');
    await flush();
    expect(t.send).toHaveBeenCalledWith('git log --oneline');
    expect(t.screen()).not.toContain('abc1234');
    expect(t.screen().endsWith('git log --oneline\r\n')).toBe(true); // no prompt while the command is out
    t.terminal.observe(result('c-1', '6fac653 (HEAD -> main) Security fix\n3e68553 Add server key\n'));
    expect(t.screen().endsWith('6fac653 (HEAD -> main) Security fix\r\n3e68553 Add server key\r\n' + PROMPT)).toBe(true);
  });

  it('ignores a result that was already in the view when the command was sent', async () => {
    const t = setup();
    t.typeLine('pwd');
    await flush();
    t.terminal.observe(result('first', 'old output'));
    expect(t.screen()).not.toContain('old output');
    t.terminal.observe(result('second', '/home/netanel/project_cibus_payment\n'));
    expect(t.screen()).toContain('/home/netanel/project_cibus_payment');
  });

  it('handles backspace, and drops input typed while a command is out', async () => {
    const t = setup();
    for (const char of 'lss') t.type(char);
    t.type('\u007f');
    t.type('\r');
    await flush();
    expect(t.send).toHaveBeenCalledWith('ls');
    t.type('x'); t.type('\r');
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it('does not send an empty line, and clear stays local', async () => {
    const t = setup();
    t.type('\r'); t.typeLine('   '); t.typeLine('CLEAR');
    await flush();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.term.clear).toHaveBeenCalledTimes(1);
  });

  it('cancels the line with Ctrl+C, also while waiting for a result', async () => {
    const t = setup();
    for (const char of 'git lo') t.type(char);
    t.type('\u0003');
    expect(t.screen().endsWith(`^C\r\n${PROMPT}`)).toBe(true);
    t.type('\r');
    await flush();
    expect(t.send).not.toHaveBeenCalled();
    t.typeLine('git log');
    await flush();
    t.type('\u0003');
    t.terminal.observe(result('late', 'late output'));
    expect(t.screen()).not.toContain('late output');
    t.typeLine('pwd');
    await flush();
    expect(t.send).toHaveBeenLastCalledWith('pwd');
  });

  it('walks the history with the arrow keys', async () => {
    const t = setup();
    t.typeLine('git log');
    await flush();
    t.terminal.observe(result('a', 'x\n'));
    t.typeLine('git status');
    await flush();
    t.terminal.observe(result('b', 'y\n'));
    t.type('\x1b[A');
    expect(t.screen().endsWith('git status')).toBe(true);
    t.type('\x1b[A');
    expect(t.screen().endsWith('git log')).toBe(true);
    t.type('\x1b[B'); t.type('\x1b[B');
    expect(t.screen().endsWith(`\x1b[2K\r${PROMPT}`)).toBe(true);
    t.type('\x1b[A'); t.type('\r');
    await flush();
    expect(t.send).toHaveBeenLastCalledWith('git status');
  });

  it('shows the sandbox state instead of sending while the sandbox is not ready', async () => {
    const t = setup({ sandbox: 'starting' });
    t.typeLine('git log');
    await flush();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.screen()).toContain('Sandbox starting. Try again in a moment.');
    t.setSandbox('restarting'); t.typeLine('git log');
    expect(t.screen()).toContain('Sandbox restarting. Try again in a moment.');
    t.setSandbox('failed'); t.typeLine('git log');
    expect(t.screen()).toContain('Sandbox failed.');
    t.setSandbox('ready'); t.typeLine('git log');
    await flush();
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    [rejected('r', 'policyBlocked'), 'Command not allowed'],
    [rejected('r', 'sandboxRestarting', 'Command timed out.'), 'Command timed out.'],
    [rejected('r', 'sandboxRestarting'), 'Sandbox restarting. Try again in a moment.'],
    [rejected('r', 'timeUp'), 'Time is up.'],
    [rejected('r', 'sessionEnded'), 'The session has ended.'],
    [rejected('r', 'puzzleLocked'), 'This terminal is locked.'],
  ])('prints the rejection %#', async (outcome, text) => {
    const t = setup();
    t.typeLine('vim');
    await flush();
    t.terminal.observe(outcome);
    expect(t.screen()).toContain(`\x1b[31m${text}\x1b[0m\r\n`);
    expect(t.screen().endsWith(PROMPT)).toBe(true);
  });

  it('reports a refused or lost submit and unblocks the line', async () => {
    const refused = setup({ reply: { error: 'conflict' } });
    refused.typeLine('ls'); await flush();
    expect(refused.screen()).toContain('This puzzle is not accepting answers right now.');
    refused.typeLine('ls'); await flush();
    expect(refused.send).toHaveBeenCalledTimes(2);
    const lost = setup({ reply: new Error('offline') });
    lost.typeLine('ls'); await flush();
    expect(lost.screen()).toContain('Cannot reach the server. Try again.');
  });

  it('stops waiting after thirty seconds without a result', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.typeLine('git log');
    await vi.advanceTimersByTimeAsync(30000);
    expect(t.screen()).toContain('No result received yet. Try again.');
    expect(t.screen().endsWith(PROMPT)).toBe(true);
  });

  it('strips terminal control sequences from the output', async () => {
    const t = setup();
    t.typeLine('git log'); await flush();
    t.terminal.observe(result('c', 'safe\x1b[2Jtext\n'));
    expect(t.screen()).toContain('safe[2Jtext');
    expect(t.screen()).not.toContain('\x1b[2J');
  });

  describe('paste', () => {
    const paste = (host: HTMLElement, text: string) => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
      host.dispatchEvent(event);
      return event;
    };
    it('puts the text on the line without running it, line breaks included', async () => {
      const t = setup();
      const event = paste(t.host, 'git log\ngit status\r\n');
      expect(event.defaultPrevented).toBe(true);
      await flush();
      expect(t.send).not.toHaveBeenCalled();
      t.type('\r');
      await flush();
      expect(t.send).toHaveBeenCalledWith('git log git status');
    });
    it('also takes multi-character data that xterm delivers as a paste', async () => {
      const t = setup();
      t.type('git\rlog');
      await flush();
      expect(t.send).not.toHaveBeenCalled();
      t.type('\r');
      await flush();
      expect(t.send).toHaveBeenCalledWith('git log');
    });
    it('does not paste into a waiting command, and caps the line at the server limit', async () => {
      const t = setup();
      paste(t.host, 'x'.repeat(MAX_COMMAND_CHARS + 50));
      t.type('\r');
      await flush();
      expect((t.send.mock.calls[0][0] as string).length).toBe(MAX_COMMAND_CHARS);
      paste(t.host, 'ignored');
      t.terminal.observe(result('c', 'ok\n'));
      t.type('\r');
      await flush();
      expect(t.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('copy', () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    beforeEach(() => { clipboard.writeText.mockClear(); vi.stubGlobal('navigator', { clipboard }); });
    afterEach(() => vi.unstubAllGlobals());
    it('copies the selection with Ctrl+Shift+C and keeps plain Ctrl+C for cancelling', async () => {
      const t = setup();
      t.term.hasSelection.mockReturnValue(true);
      t.term.getSelection.mockReturnValue('-----BEGIN RSA PRIVATE KEY-----');
      expect(t.key({ type: 'keydown', ctrlKey: true, shiftKey: true, key: 'C' })).toBe(false);
      await flush();
      expect(clipboard.writeText).toHaveBeenCalledWith('-----BEGIN RSA PRIVATE KEY-----');
      expect(t.key({ type: 'keydown', ctrlKey: true, shiftKey: false, key: 'c' })).toBe(true);
      expect(t.key({ type: 'keydown', metaKey: true, key: 'c' })).toBe(true); // Cmd+C is the browser's own copy
      t.term.hasSelection.mockReturnValue(false);
      expect(t.key({ type: 'keydown', ctrlKey: true, shiftKey: true, key: 'C' })).toBe(true);
    });
    it('copies on right-click when something is selected, and otherwise leaves the browser menu', async () => {
      const t = setup();
      t.term.hasSelection.mockReturnValue(true);
      t.term.getSelection.mockReturnValue('selected');
      const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      t.host.dispatchEvent(menu);
      await flush();
      expect(menu.defaultPrevented).toBe(true);
      expect(clipboard.writeText).toHaveBeenCalledWith('selected');
      t.term.hasSelection.mockReturnValue(false);
      const plain = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      t.host.dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(false);
    });
  });
});

describe('git terminal after a ruin', () => {
  const ruined = (commandId: string): EvaluationView => ({ commandId, verdict: 'ruined', reason: null, output: '[main abc1234] x\n' });
  const sentCommand = async (t: ReturnType<typeof setup>, line: string) => { t.typeLine(line); await flush(); };

  it('a ruined result clears the scrollback, shows the notice and locks input; the new ready generation brings a fresh intro', async () => {
    const t = setup();
    t.terminal.sync('ready', 1);
    await sentCommand(t, 'git commit --allow-empty -m x');
    t.terminal.observe(ruined('c-1'));
    expect(t.term.clear).toHaveBeenCalledTimes(1);
    expect(t.screen().endsWith(`\x1b[31m${RESET_NOTICE}\x1b[0m\r\n`)).toBe(true);
    expect(t.screen()).not.toContain('abc1234');
    t.terminal.sync('ready', 1); // still the ruined generation: not ready yet
    t.terminal.sync('restarting', 2);
    const before = t.screen();
    t.typeLine('git log');
    await flush();
    expect(t.screen()).toBe(before); // input is disabled
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.term.clear).toHaveBeenCalledTimes(1);
    t.terminal.sync('ready', 2);
    expect(t.screen().endsWith(INTRO.map(line => `\x1b[36m${line}\x1b[0m\r\n`).join('') + PROMPT)).toBe(true);
    t.typeLine('git log');
    await flush();
    expect(t.send).toHaveBeenCalledTimes(2);
  });

  it('a higher generation alone resets the terminal, even when the ruined result was missed', () => {
    const t = setup();
    t.terminal.sync('ready', 1);
    t.type('ab');
    t.terminal.sync('restarting', 2);
    expect(t.term.clear).toHaveBeenCalledTimes(1);
    expect(t.screen()).toContain(RESET_NOTICE);
    t.terminal.sync('ready', 2);
    expect(t.screen().endsWith(PROMPT)).toBe(true);
  });

  it('the first state seen is not a reset, and the same generation staying ready does nothing', () => {
    const t = setup();
    t.terminal.sync('ready', 3);
    t.terminal.sync('ready', 3);
    expect(t.term.clear).not.toHaveBeenCalled();
    expect(t.screen()).not.toContain(RESET_NOTICE);
  });
});

describe('git terminal and engine-level rejections', () => {
  it('prints a rejection that arrives as a result of the session view', async () => {
    const t = setup();
    t.typeLine('git log');
    await flush();
    t.terminal.observe(rejected('c-9', 'puzzleLocked'));
    expect(t.screen().endsWith('\x1b[31mThis terminal is locked.\x1b[0m\r\n' + PROMPT)).toBe(true);
  });
});
