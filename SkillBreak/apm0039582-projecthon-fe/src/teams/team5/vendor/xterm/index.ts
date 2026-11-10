import './xterm.js';
import './addon-fit.js';
import './xterm.css';

/** The part of the xterm.js API the Team 5 terminal uses (the vendored bundle is plain JavaScript). */
export interface TerminalOptions {
  cursorBlink?: boolean; scrollback?: number; convertEol?: boolean; fontFamily?: string; fontSize?: number;
  theme?: { background?: string; foreground?: string; cursor?: string; selectionBackground?: string };
}
export interface Disposable { dispose(): void }
export interface TerminalAddon { activate(terminal: unknown): void; dispose(): void }
export interface XTerm {
  readonly element: HTMLElement | undefined;
  open(parent: HTMLElement): void;
  loadAddon(addon: TerminalAddon): void;
  write(data: string): void;
  writeln(data: string): void;
  clear(): void;
  focus(): void;
  dispose(): void;
  hasSelection(): boolean;
  getSelection(): string;
  onData(listener: (data: string) => void): Disposable;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
}
export interface XTermFit extends TerminalAddon { fit(): void }

// The UMD bundles assign `Terminal` and `FitAddon` on the global object when they are loaded as browser modules.
// Where they do not (a test runner that supplies CommonJS globals), the constructors are undefined and callers must check.
const root = globalThis as unknown as { Terminal?: new (options?: TerminalOptions) => XTerm; FitAddon?: { FitAddon: new () => XTermFit } };
export const Terminal = root.Terminal;
export const FitAddon = root.FitAddon?.FitAddon;
