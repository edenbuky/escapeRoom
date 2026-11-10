import { useEffect, useState, type FormEvent } from 'react';
import { ROOM_1_ASSETS } from '../../room-design/room-assets';
import { markPasswordCracked } from '../../room-1-progress';
import { copyShownValue, trimSingleLineInput } from '../room-1-ui.helpers';
import { DeviceScreen, percentBox } from '../shared/DeviceScreen';
import { submitErrorMessage } from '../shared/submit-error';
import type { PuzzleScreenProps } from '../types';
import { useDeviceDraft } from '../../device-drafts';

export function HashCrackerScreen({ puzzle, view, submit }: PuzzleScreenProps) {
  const [hash, setHash] = useDeviceDraft(view.sessionId, 'hash');
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [copied, setCopied] = useState<{ description: string; state: 'copied' | 'selected' }>();
  const result = puzzle.latestResult;
  const description = result && (result.verdict === 'solved' || result.verdict === 'progress') ? result.output : '';
  useEffect(() => { if (puzzle.status === 'solved') markPasswordCracked(view.sessionId); }, [puzzle.status, view.sessionId]);

  const crack = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true); setSubmitError('');
    try {
      const reply = await submit({ kind: 'answer', answer: trimSingleLineInput(hash) });
      if (reply !== 'accepted') setSubmitError(submitErrorMessage(reply));
    } catch { setSubmitError('Cannot reach the server. Try again.'); }
    finally { setPending(false); }
  };
  // The device has no error element in the design, so a failed submit shows on its own output display.
  const output = pending ? 'Cracking…' : submitError || description || (!result ? ''
    : result.reason === 'policyBlocked' ? 'Not a valid SHA-256 hash.' : 'No match found.');
  // Click-to-copy on the shown password (spec 005: a copy control for the output; the design has no button).
  const copyable = output === description && description !== '';
  const copyDescription = async (shown: Element) => {
    const state = await copyShownValue(shown, description);
    if (state !== 'skipped') setCopied({ description, state });
  };
  const copyState = copyable && copied?.description === description ? copied.state : undefined;
  return <>
    <div className="modal-title">Hash Cracker</div>
    <DeviceScreen image={ROOM_1_ASSETS['hash-cracker-streight']} label="Hash Cracker" onSubmit={crack}>
      <input className="screen-input" aria-label="Input hash" type="text" autoComplete="off" spellCheck={false}
        value={hash} onChange={event => setHash(event.target.value)}
        style={percentBox({ left: 15.5, top: 47.4, width: 49.8, height: 7.7 })} />
      <output className="screen-output t5-hash-description" aria-label="Output" data-copy={copyState}
        {...(copyable ? { role: 'button', tabIndex: 0, title: 'Click to copy' } : {})}
        onClick={copyable ? event => void copyDescription(event.currentTarget) : undefined}
        onKeyDown={copyable ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void copyDescription(event.currentTarget); } } : undefined}
        style={percentBox({ left: 15.5, top: 64.9, width: 64, height: 7.8 })}>{output}</output>
      <button type="submit" className="screen-action" aria-label="CRACK" disabled={pending}
        style={percentBox({ left: 67.4, top: 46.6, width: 13.1, height: 8.9 })} />
    </DeviceScreen>
    <div className="modal-note" role="status">{copyState === 'copied' ? 'Copied' : copyState === 'selected' ? 'Selected; copy it manually'
      : copyable ? 'Click the description to copy it' : 'Paste a hash and press CRACK'}</div>
  </>;
}
