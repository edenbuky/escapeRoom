import { useState, type FormEvent } from 'react';
import { ROOM_2_ASSETS } from '../../room-design/room-assets';
import { trimSingleLineInput } from '../room-1-ui.helpers';
import { DeviceScreen, percentBox } from '../shared/DeviceScreen';
import { submitErrorMessage } from '../shared/submit-error';
import type { PuzzleScreenProps } from '../types';
import { useDeviceDraft } from '../../device-drafts';
import './tls-decryptor-screen.css';

const REJECTIONS: Record<string, string> = {
  wrongAnswer: 'Decryption failed. Check the PMS and the Client Random.',
  policyBlocked: 'Invalid input. The PMS and the Client Random must be hex values.',
  timeUp: 'Time is up.',
  sessionEnded: 'This session has ended.',
  sandboxRestarting: 'The decryptor is busy. Try again.',
  puzzleLocked: 'This machine is locked.',
};

export function TlsDecryptorScreen({ puzzle, view, submit }: PuzzleScreenProps) {
  const [pms, setPms] = useDeviceDraft(view.sessionId, 'tlsPms');
  const [clientRandom, setClientRandom] = useDeviceDraft(view.sessionId, 'tlsClientRandom');
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const result = puzzle.latestResult;
  const solved = result?.verdict === 'solved' ? result.output : '';

  const decrypt = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true); setSubmitError('');
    try {
      const reply = await submit({ kind: 'tls', pms: trimSingleLineInput(pms), clientRandom: trimSingleLineInput(clientRandom) });
      if (reply !== 'accepted') setSubmitError(submitErrorMessage(reply));
    } catch { setSubmitError('Cannot reach the server. Try again.'); }
    finally { setPending(false); }
  };
  const output = pending ? 'Decrypting…' : submitError || solved
    || (result?.verdict === 'rejected' ? REJECTIONS[result.reason ?? ''] ?? 'Decryption failed.' : '');
  return <>
    <div className="modal-title">TLS Decryptor</div>
    <DeviceScreen image={ROOM_2_ASSETS['tls-decryptor-front']} label="TLS Decryptor" onSubmit={decrypt}>
      <input className="screen-input" name="pms" aria-label="PMS" type="text" autoComplete="off" spellCheck={false}
        value={pms} onChange={event => setPms(event.target.value)}
        style={percentBox({ left: 39, top: 29.2, width: 42.2, height: 5.1 })} />
      <input className="screen-input" name="clientRandom" aria-label="Client Random" type="text" autoComplete="off" spellCheck={false}
        value={clientRandom} onChange={event => setClientRandom(event.target.value)}
        style={percentBox({ left: 39, top: 37.1, width: 42.2, height: 5.1 })} />
      <output className="screen-output t5-tls-output" aria-label="Output"
        style={percentBox({ left: 18.9, top: 68.7, width: 62.2, height: 6.6 })}>{output}</output>
      <button type="submit" className="screen-action" aria-label="Decrypt" disabled={pending}
        style={percentBox({ left: 36.4, top: 54, width: 27.4, height: 7.7 })} />
    </DeviceScreen>
    <div className="modal-note" role="status">{solved ? 'The capture on Nathanel’s computer is now readable'
      : 'Enter the PMS and the Client Random, then press Decrypt'}</div>
  </>;
}
