import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

/** Clicks here belong to the puzzle (design L1228: the screen, the window, the desktop) or to a control. */
const KEEPS_OPEN = '.interactive-screen, .window-shell, .desktop-scene, .t5-panel-state, button, input, textarea, select, a, label';
const outside = (target: EventTarget | null) => !(target instanceof Element && target.closest(KEEPS_OPEN));
const CONTROLS = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]';

/** The design's modal: blurred backdrop, round × at the top right, the screen's pieces stacked in `.modal-content`. */
export function ZoomPanel({ title, close, trigger, screen, children }: {
  title: string; close: () => void;
  /** The control that opened the window; it gets the focus back when the window closes (design lastFocused). */
  trigger: RefObject<HTMLElement | null>;
  /** Names what the window shows; when it changes the window takes the focus again, as the design's openModal does for each screen. */
  screen: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pressedOn = useRef<EventTarget | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>(CONTROLS) ?? []);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      // Focus that left the window (its control was removed or disabled) comes back to the first control (design L1240-1243).
      if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === content.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === content.current)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
      const opener = trigger.current;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => { content.current?.focus({ preventScroll: true }); }, [screen]);
  // A press that starts on the puzzle and is released outside it (selecting text) does not close the window.
  return <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={dialog}
    onMouseDown={event => { pressedOn.current = event.target; }}
    onClick={event => {
      const pressedOutside = outside(pressedOn.current);
      pressedOn.current = null;
      if (pressedOutside && outside(event.target)) close();
    }}>
    <button type="button" className="modal-close" aria-label="Close puzzle" onClick={close}>×</button>
    <div className="modal-content" tabIndex={-1} ref={content}>{children}</div>
  </div>;
}
