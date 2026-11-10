import { useEffect, useRef } from 'react';
import type { PuzzleScreenProps } from '../types';
import { createGitTerminal, type GitSandboxState } from './git-terminal';
import './nethanel-git-screen.css';

const FONT = 'ui-monospace, SFMono-Regular, Consolas, monospace';
const LABEL: Record<GitSandboxState, string> = {
  starting: 'Sandbox starting', ready: 'Ready', restarting: 'Sandbox restarting', failed: 'Sandbox failed',
};

/** Same reading of the git puzzle as the room's status line: provisioning again after a restart is "restarting". */
export function gitSandboxState(puzzle: PuzzleScreenProps['puzzle']): GitSandboxState {
  const { status, generation } = puzzle.sandbox;
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  const rejected = puzzle.latestResult?.verdict === 'rejected' && puzzle.latestResult.reason === 'sandboxRestarting';
  return status === 'provisioning' && (generation > 1 || rejected) ? 'restarting' : 'starting';
}

/**
 * Nathanel's git terminal (design showTerminal('git')): the window frame, an xterm.js terminal and a footer.
 * Each Enter sends one command; what the terminal prints for it is the `latestResult.output` of the session view.
 * xterm.js is vendored and loaded when the window opens.
 */
export function NathanelGitScreen({ puzzle, view, submit, close }: PuzzleScreenProps) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof createGitTerminal>>();
  const state = gitSandboxState(puzzle);
  // The session view's latest result also carries what the engine rejected: a puzzle's own latestResult does not
  // (script v3+ stores no engine-level rejection on the puzzle), and the terminal would wait for it in vain.
  const result = view.latestResult ?? puzzle.latestResult;
  const generation = puzzle.sandbox.generation;
  const latest = useRef({ state, generation, submit, resultId: result?.commandId ?? null });
  latest.current = { state, generation, submit, resultId: result?.commandId ?? null };

  useEffect(() => {
    const element = host.current!;
    let disposed = false;
    let cleanup = () => {};
    void import('../../../vendor/xterm').then(({ Terminal, FitAddon }) => {
      if (disposed) return;
      if (typeof Terminal !== 'function') { element.textContent = 'Cannot load the terminal.'; return; }
      const term = new Terminal({ cursorBlink: true, scrollback: 500, convertEol: true, fontFamily: FONT, fontSize: 14,
        theme: { background: '#080e18', foreground: '#d9f2ff', cursor: '#6ee7ff', selectionBackground: '#2864a977' } });
      const fit = typeof FitAddon === 'function' ? new FitAddon() : undefined;
      if (fit) term.loadAddon(fit);
      term.open(element);
      fit?.fit();
      const terminal = createGitTerminal({ term, host: element, sandbox: () => latest.current.state,
        send: command => latest.current.submit({ kind: 'command', command }), resultId: () => latest.current.resultId });
      controller.current = terminal;
      terminal.sync(latest.current.state, latest.current.generation);
      const refit = () => fit?.fit();
      window.addEventListener('resize', refit);
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : undefined;
      observer?.observe(element);
      // The window takes the focus when it opens; the terminal takes it back right after.
      const focus = setTimeout(() => term.focus(), 0);
      cleanup = () => {
        clearTimeout(focus);
        window.removeEventListener('resize', refit);
        observer?.disconnect();
        terminal.dispose();
        controller.current = undefined;
        term.dispose();
      };
    });
    return () => { disposed = true; cleanup(); };
  }, []);

  useEffect(() => { controller.current?.observe(result); }, [result]);
  useEffect(() => { controller.current?.sync(state, puzzle.sandbox.generation); }, [state, puzzle.sandbox.generation]);

  return <section className="window-shell terminal-window" aria-label="Git terminal">
    <div className="window-header">
      <button type="button" className="window-back" onClick={close}>← Nathanel's computer</button>
      <span className="window-name">⌘ Netanel · Git terminal · project_cibus_payment</span>
    </div>
    <div className="window-subtitle" role="status">Git sandbox · {LABEL[state]}</div>
    <div className="terminal-host" ref={host} />
    <div className="window-footer">Type help · Click outside the window or press Esc to go back</div>
  </section>;
}
