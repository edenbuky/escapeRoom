import { useEffect, useState, type FormEvent } from 'react';
import { ROOM_1_ASSETS } from '../../room-design/room-assets';
import { markPasswordCracked } from '../../room-1-progress';
import { copyShownValue, trimSingleLineInput } from '../room-1-ui.helpers';
import { DeviceScreen, percentBox } from '../shared/DeviceScreen';
import { submitErrorMessage } from '../shared/submit-error';
import type { PuzzleScreenProps } from '../types';

/** The typed hash per game session, kept while the window is closed (design deviceDrafts). */
const hashDrafts = new Map<string, string>();

export function HashCrackerScreen({ puzzle, view, submit }: PuzzleScreenProps) {
  const [hash, setHash] = useState(() => hashDrafts.get(view.sessionId) ?? '');
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [copied, setCopied] = useState<{ password: string; state: 'copied' | 'selected' }>();
  const result = puzzle.latestResult;
  const password = puzzle.status === 'solved' && result?.verdict === 'solved' ? result.output : '';
  useEffect(() => { if (password) markPasswordCracked(view.sessionId); }, [password, view.sessionId]);

  const crack = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true); setSubmitError('');
    const reply = await submit({ kind: 'answer', answer: trimSingleLineInput(hash) });
    setPending(false);
    if (reply !== 'accepted') setSubmitError(submitErrorMessage(reply));
  };
  // The device has no error element in the design, so a failed submit shows on its own output display.
  const output = pending ? 'Cracking…' : submitError || password || (!result ? ''
    : result.reason === 'policyBlocked' ? 'Not a valid SHA-256 hash.' : 'No match found.');
  // Click-to-copy on the shown password (spec 005: a copy control for the output; the design has no button).
  const copyable = output === password && password !== '';
  const copyPassword = async (shown: Element) => {
    const state = await copyShownValue(shown, password);
    if (state !== 'skipped') setCopied({ password, state });
  };
  const copyState = copyable && copied?.password === password ? copied.state : undefined;
  return <>
    <div className="modal-title">Hash Cracker</div>
    <DeviceScreen image={ROOM_1_ASSETS['hash-cracker-streight']} label="Hash Cracker" onSubmit={crack}>
      <input className="screen-input" aria-label="Input hash" type="text" autoComplete="off" spellCheck={false}
        value={hash} onChange={event => { setHash(event.target.value); hashDrafts.set(view.sessionId, event.target.value); }}
        style={percentBox({ left: 15.5, top: 47.4, width: 49.8, height: 7.7 })} />
      <output className="screen-output" aria-label="Output" data-copy={copyState}
        {...(copyable ? { role: 'button', tabIndex: 0, title: 'Click to copy' } : {})}
        onClick={copyable ? event => void copyPassword(event.currentTarget) : undefined}
        onKeyDown={copyable ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void copyPassword(event.currentTarget); } } : undefined}
        style={percentBox({ left: 15.5, top: 64.9, width: 64, height: 7.8 })}>{output}</output>
      <button type="submit" className="screen-action" aria-label="CRACK" disabled={pending}
        style={percentBox({ left: 67.4, top: 46.6, width: 13.1, height: 8.9 })} />
    </DeviceScreen>
    <div className="modal-note">{copyable ? 'Click the password to copy it' : 'Paste a hash and press CRACK'}</div>
  </>;
}
