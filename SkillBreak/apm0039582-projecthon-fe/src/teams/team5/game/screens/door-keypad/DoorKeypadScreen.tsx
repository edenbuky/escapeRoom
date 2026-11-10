import { useEffect, useRef, useState } from 'react';
import { ROOM_2_ASSETS } from '../../room-design/room-assets';
import { DeviceScreen, percentBox } from '../shared/DeviceScreen';
import { submitErrorMessage } from '../shared/submit-error';
import type { PuzzleScreenProps } from '../types';
import { useDeviceDraft } from '../../device-drafts';
import './door-keypad.css';

const LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'clear', 'enter'];
const X = [18.4, 35.0, 51.4, 67.7];
const Y = [47.1, 60.9, 74.4];
const LENGTH = 16;

/** Door keypad (design showKeypad): four groups of four digits; the code is checked by the server (`answer`). */
export function DoorKeypadScreen({ puzzle, view, submit, openDoor, doorPending }: PuzzleScreenProps) {
  const [digits, setDigits] = useDeviceDraft(view.sessionId, 'door-code');
  // Keys can arrive several times before a re-render, so the latest digits live in a ref that is updated synchronously.
  const digitsRef = useRef(digits);
  useEffect(() => { digitsRef.current = digits; }, [digits]);
  const update = (next: string) => { digitsRef.current = next; setDigits(next); };
  const [feedback, setFeedback] = useState<{ text: string; outcome: '' | 'denied' | 'granted'; shake: number }>({ text: '', outcome: '', shake: 0 });
  const [pending, setPending] = useState(false);
  const [pressed, setPressed] = useState<string>();
  const solved = puzzle.status === 'solved';
  const denied = (text: string, outcome: 'denied' | 'granted' = 'denied') => setFeedback(previous => ({ text, outcome, shake: previous.shake + 1 }));
  // A wrong code arrives as the puzzle's latest rejection; one already in the view when the screen opens is not shown.
  const rejection = puzzle.latestResult?.verdict === 'rejected' && puzzle.latestResult.reason === 'wrongAnswer'
    ? puzzle.latestResult.commandId : undefined;
  const seenRejection = useRef(rejection);
  useEffect(() => {
    if (rejection && rejection !== seenRejection.current) denied('ACCESS DENIED');
    seenRejection.current = rejection;
  }, [rejection]);
  const shown = solved ? { text: 'ACCESS GRANTED', outcome: 'granted' as const, shake: feedback.shake } : feedback;

  async function press(key: string) {
    if (solved) { denied('ACCESS GRANTED', 'granted'); return; }
    if (pending) return;
    if (key === 'clear') { update(digitsRef.current.slice(0, -1)); setFeedback(previous => ({ ...previous, text: '', outcome: '' })); }
    else if (key === 'enter') {
      const current = digitsRef.current;
      if (current.length !== LENGTH) { denied('ENTER ALL 16 DIGITS'); return; }
      setPending(true);
      try {
        const result = await submit({ kind: 'answer', answer: current });
        if (result !== 'accepted') denied(submitErrorMessage(result).toUpperCase());
      } catch { denied('CONNECTION LOST'); }
      finally { setPending(false); }
    } else if (/^[0-9]$/.test(key)) {
      // A new digit after a full invalid attempt begins the next attempt.
      update((digitsRef.current.length === LENGTH ? '' : digitsRef.current) + key);
      setFeedback(previous => ({ ...previous, text: '', outcome: '' }));
    }
  }
  const latest = useRef(press);
  latest.current = press;
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (/^[0-9]$/.test(event.key) || event.key === 'Backspace' || event.key === 'Enter') {
        event.preventDefault();
        void latest.current(event.key === 'Backspace' ? 'clear' : event.key === 'Enter' ? 'enter' : event.key);
      }
    }
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, []);

  const groups = digits.padEnd(LENGTH, '_').match(/.{1,4}/g) ?? [];
  return <>
    <div className="modal-title">Exit keypad · Enter 16 digits</div>
    <DeviceScreen className="keypad-scene" image={ROOM_2_ASSETS['keypad-front']} label="Front view of the keypad with number pad and display">
      <div key={shown.shake} className={`keypad-display ${shown.outcome}`.trim()} dir="ltr" role="status" aria-live="polite">
        <div className="keypad-readout" dir="ltr">{groups.map((group, index) => <span key={index} className="keypad-group" dir="ltr">{group}</span>)}</div>
        <div className="keypad-status">{shown.text}</div>
      </div>
      {LABELS.map((key, index) => <button key={key} type="button" data-key={key}
        className={`keypad-key${pressed === key ? ' pressed' : ''}`}
        aria-label={key === 'clear' ? 'Delete digit' : key === 'enter' ? 'Confirm code' : `Digit ${key}`}
        style={percentBox({ left: X[index % 4], top: Y[Math.floor(index / 4)], width: 14.5, height: 12.5 })}
        onPointerDown={() => setPressed(key)} onPointerUp={() => setPressed(undefined)}
        onPointerLeave={() => setPressed(undefined)} onPointerCancel={() => setPressed(undefined)}
        onClick={() => { setPressed(key); window.setTimeout(() => setPressed(undefined), 145); void press(key); }}>
        {key === 'clear' ? '×' : key === 'enter' ? '✓' : key}
      </button>)}
    </DeviceScreen>
    <div className="keypad-tools">
      {!solved && <input type="text" inputMode="numeric" aria-label="Paste code" placeholder="Paste code" autoComplete="off"
        value="" onChange={event => { update(event.target.value.replace(/\D/g, '').slice(0, LENGTH));
          setFeedback(previous => ({ ...previous, text: '', outcome: '' })); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void press('enter'); } }} />}
      {solved && !view.currentRoom.doorOpenedAt && openDoor && <button type="button" className="t5-primary"
        disabled={doorPending} onClick={() => void openDoor()}>Open door</button>}
    </div>
    <div className="modal-note">Type the 16 digits from left to right · × to delete · ✓ to confirm · the keyboard works too</div>
  </>;
}
