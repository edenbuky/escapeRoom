import type { EvaluationView } from '../../../contracts/view';
import type { XTerm } from '../../../vendor/xterm';
import { submitErrorMessage } from '../shared/submit-error';
import type { SubmitResult } from '../types';

export type GitSandboxState = 'starting' | 'ready' | 'restarting' | 'failed';
/** The longest line the server accepts (the template's maxCommandChars). */
export const MAX_COMMAND_CHARS = 4096;
export const PROMPT = 'netanel@tdp:~/project_cibus_payment$ ';
export const INTRO = ['Netanel Workstation — project history', 'Type help, or try: git log --oneline'];
const WAIT_MS = 30000;

const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const toTerminal = (text: string) => text.replace(/\r?\n/g, '\r\n');
// Backend output is plain text; control characters (escape sequences) never reach the screen.
const printable = (text: string) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

export const RESET_NOTICE = 'Puzzle reset – sandbox restarting';

const NOT_READY: Record<Exclude<GitSandboxState, 'ready'>, string> = {
  starting: 'Sandbox starting. Try again in a moment.',
  restarting: 'Sandbox restarting. Try again in a moment.',
  failed: 'Sandbox failed. The terminal cannot run commands.',
};

/** What the player sees for a result the server rejected (RejectionReason). */
function rejection(result: Extract<EvaluationView, { verdict: 'rejected' }>): string {
  switch (result.reason) {
    case 'policyBlocked': return 'Command not allowed';
    case 'sandboxRestarting': return result.output.trim() || 'Sandbox restarting. Try again in a moment.';
    case 'timeUp': return 'Time is up.';
    case 'sessionEnded': return 'The session has ended.';
    case 'puzzleLocked': return 'This terminal is locked.';
    default: return 'Command rejected.';
  }
}

interface Deps {
  term: XTerm;
  host: HTMLElement;
  sandbox: () => GitSandboxState;
  send: (command: string) => Promise<SubmitResult>;
  /** The id of the result the session view carries now. */
  resultId: () => string | null;
}

/**
 * Line editor of the git terminal (design showTerminal): prompt, typing, backspace, Ctrl+C and history. Enter
 * sends the line as one command; nothing is simulated locally except `clear`. The output printed for a command
 * is `latestResult.output` of the session view, handed in through `observe`.
 * Pasted text goes into the line; its line breaks never run anything.
 */
export function createGitTerminal({ term, host, sandbox, send, resultId }: Deps) {
  let buffer = '';
  const history: string[] = [];
  let historyIndex = 0;
  let pending: { after: string | null; timer: ReturnType<typeof setTimeout> } | undefined;
  let lastSeen = resultId();
  // After a ruin the sandbox is rebuilt from scratch: the terminal is locked from the notice until the new
  // generation reports ready. `generation` is the one the terminal has seen; `resetFrom` the one that was ruined.
  let generation: number | undefined;
  let resetFrom: number | undefined;
  let resetting = false;

  const prompt = () => term.write(PROMPT);
  const eraseLine = () => term.write(`\x1b[2K\r${PROMPT}`);
  const show = (line: string) => { buffer = line; eraseLine(); term.write(line); };

  function finish(text: string, error = false) {
    if (pending) clearTimeout(pending.timer);
    pending = undefined;
    const clean = printable(text).replace(/\n$/, '');
    if (clean) term.write(`${error ? red(toTerminal(clean)) : toTerminal(clean)}\r\n`);
    prompt();
  }

  function insert(text: string) {
    const clean = printable(text.replace(/\s*[\r\n]+\s*/g, ' '));
    const room = MAX_COMMAND_CHARS - buffer.length;
    if (!clean || room <= 0) return;
    const accepted = clean.slice(0, room);
    buffer += accepted;
    term.write(accepted);
  }

  function beginReset(from = generation) {
    if (resetting) return;
    resetting = true;
    resetFrom = from;
    if (pending) clearTimeout(pending.timer);
    pending = undefined;
    buffer = '';
    historyIndex = history.length;
    term.clear();
    term.write(`\x1b[2K\r${red(RESET_NOTICE)}\r\n`);
  }

  function finishReset() {
    resetting = false;
    resetFrom = undefined;
    INTRO.forEach(line => term.writeln(cyan(line)));
    prompt();
  }

  async function run(line: string) {
    const command = line.trim();
    buffer = '';
    term.write('\r\n');
    if (!command) { prompt(); return; }
    history.push(line);
    historyIndex = history.length;
    if (command.toLowerCase() === 'clear') { term.clear(); prompt(); return; }
    const state = sandbox();
    if (state !== 'ready') { finish(NOT_READY[state], true); return; }
    const timer = setTimeout(() => finish('No result received yet. Try again.', true), WAIT_MS);
    pending = { after: lastSeen, timer };
    const mine = pending;
    try {
      const reply = await send(command);
      if (reply !== 'accepted' && pending === mine) finish(submitErrorMessage(reply), true);
    } catch {
      if (pending === mine) finish('Cannot reach the server. Try again.', true);
    }
  }

  const keys = term.onData(data => {
    if (resetting) return;
    if (data === '\u0003') {
      if (pending) { clearTimeout(pending.timer); pending = undefined; }
      buffer = '';
      term.write(`^C\r\n${PROMPT}`);
      return;
    }
    if (pending) return;
    if (data === '\r') void run(buffer);
    else if (data === '\u007f' || data === '\b') {
      if (buffer.length) { buffer = buffer.slice(0, -1); term.write('\b \b'); }
    } else if (data === '\x1b[A' || data === '\x1b[B') {
      if (!history.length) return;
      historyIndex = data === '\x1b[A' ? Math.max(0, historyIndex - 1) : Math.min(history.length, historyIndex + 1);
      show(history[historyIndex] ?? '');
    } else if (!data.startsWith('\x1b') && data >= ' ') insert(data);
  });

  // Paste (Cmd+V, Ctrl+Shift+V, the context menu) arrives as a paste event: take it as one line of text.
  const onPaste = (event: ClipboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!pending && !resetting) insert(event.clipboardData?.getData('text/plain') ?? '');
  };
  host.addEventListener('paste', onPaste, true);

  async function copySelection() {
    const text = term.getSelection();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch { /* the selection stays highlighted for a manual copy */ }
  }
  // Cmd+C copies natively. Ctrl+Shift+C and Ctrl+Insert copy the selection; plain Ctrl+C stays "cancel the line".
  term.attachCustomKeyEventHandler(event => {
    const copy = event.type === 'keydown' && term.hasSelection()
      && ((event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') || (event.ctrlKey && event.key === 'Insert'));
    if (copy) { void copySelection(); return false; }
    return true;
  });
  // Right-click on a selection copies it; with nothing selected the browser's own menu (with Paste) opens.
  const onContextMenu = (event: MouseEvent) => {
    if (!term.hasSelection()) return;
    event.preventDefault();
    void copySelection();
  };
  host.addEventListener('contextmenu', onContextMenu);

  INTRO.forEach(line => term.writeln(cyan(line)));
  prompt();

  return {
    /** The session view's current result; when a command waits for one, its output is printed. */
    observe(result: EvaluationView | null) {
      const id = result?.commandId ?? null;
      if (id === lastSeen) return;
      lastSeen = id;
      if (result?.verdict === 'ruined') { beginReset(); return; }
      if (!pending || !result || id === pending.after) return;
      finish(result.verdict === 'rejected' ? rejection(result) : result.output, result.verdict === 'rejected');
    },
    /**
     * The git puzzle's sandbox as the session view has it. A higher generation than the one seen means the
     * puzzle was reset (also when the ruined result was missed); `ready` of that newer generation ends the reset.
     */
    sync(state: GitSandboxState, next: number) {
      const previous = generation;
      generation = next;
      if (previous !== undefined && next > previous) beginReset(previous);
      if (resetting && state === 'ready' && (resetFrom === undefined || next > resetFrom)) finishReset();
    },
    dispose() {
      if (pending) clearTimeout(pending.timer);
      pending = undefined;
      keys.dispose();
      host.removeEventListener('paste', onPaste, true);
      host.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
