import { useState, type FormEvent } from 'react';
import { ROOM_2_ASSETS } from '../../room-design/room-assets';
import { copyShownValue, trimSingleLineInput } from '../room-1-ui.helpers';
import { DeviceScreen, percentBox } from '../shared/DeviceScreen';
import { submitErrorMessage } from '../shared/submit-error';
import type { PuzzleScreenProps } from '../types';
import { useDeviceDraft } from '../../device-drafts';
import './rsa-decryptor-screen.css';

const REJECTIONS: Record<string, string> = {
  wrongAnswer: 'Decryption failed. Check the key, N and the encrypted PMS.',
  policyBlocked: 'Invalid input. Check the private key and the hex values.',
  timeUp: 'Time is up.',
  sessionEnded: 'This session has ended.',
  sandboxRestarting: 'The decryptor is busy. Try again.',
  puzzleLocked: 'This machine is locked.',
};

export function RsaDecryptorScreen({ puzzle, view, submit }: PuzzleScreenProps) {
  const [privateKey, setPrivateKey] = useDeviceDraft(view.sessionId, 'rsaPrivateKey');
  const [modulus, setModulus] = useDeviceDraft(view.sessionId, 'rsaModulus');
  const [encryptedPms, setEncryptedPms] = useDeviceDraft(view.sessionId, 'rsaEncryptedPms');
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [copied, setCopied] = useState<{ value: string; state: 'copied' | 'selected' }>();
  const result = puzzle.latestResult;
  const pms = result?.verdict === 'solved' ? result.output : '';

  const decrypt = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true); setSubmitError('');
    try {
      // The key keeps its line breaks; the single-line hex fields are trimmed.
      const reply = await submit({ kind: 'rsa', privateKey, encryptedPms: trimSingleLineInput(encryptedPms), modulus: trimSingleLineInput(modulus) });
      if (reply !== 'accepted') setSubmitError(submitErrorMessage(reply));
    } catch { setSubmitError('Cannot reach the server. Try again.'); }
    finally { setPending(false); }
  };
  const output = pending ? 'Decrypting…' : submitError || pms
    || (result?.verdict === 'rejected' ? REJECTIONS[result.reason ?? ''] ?? 'Decryption failed.' : '');
  const copyState = pms && copied?.value === pms ? copied.state : undefined;
  const copy = async (button: HTMLElement) => {
    const shown = button.parentElement?.querySelector('output');
    if (!shown) return;
    const state = await copyShownValue(shown, pms);
    if (state !== 'skipped') setCopied({ value: pms, state });
  };
  return <>
    <div className="modal-title">RSA Decryptor</div>
    <DeviceScreen image={ROOM_2_ASSETS['rsa-decryptor-front']} label="RSA Decryptor" onSubmit={decrypt}>
      <textarea className="screen-input t5-rsa-key" name="privateKey" aria-label="Private key" autoComplete="off" spellCheck={false} wrap="off"
        value={privateKey} onChange={event => setPrivateKey(event.target.value)}
        style={percentBox({ left: 18, top: 27.1, width: 64, height: 5.8 })} />
      <input className="screen-input" name="modulus" aria-label="RSA modulus (N)" type="text" autoComplete="off" spellCheck={false}
        value={modulus} onChange={event => setModulus(event.target.value)}
        style={percentBox({ left: 18, top: 41.1, width: 64, height: 5.8 })} />
      <input className="screen-input" name="encryptedPms" aria-label="Encrypted PMS" type="text" autoComplete="off" spellCheck={false}
        value={encryptedPms} onChange={event => setEncryptedPms(event.target.value)}
        style={percentBox({ left: 18, top: 55.1, width: 64, height: 5.8 })} />
      <output className="screen-output t5-rsa-output" aria-label="Output" data-copy={copyState}
        style={percentBox({ left: 18, top: 76.1, width: 64, height: 6.6 })}>{output}</output>
      {pms && <button type="button" className="t5-rsa-copy" aria-label="Copy" onClick={event => void copy(event.currentTarget)}
        style={percentBox({ left: 70.5, top: 77.3, width: 10.5, height: 4.2 })}>{copyState === 'copied' ? 'Copied' : 'Copy'}</button>}
      <button type="submit" className="screen-action" aria-label="Decrypt" disabled={pending}
        style={percentBox({ left: 35.5, top: 64.2, width: 29, height: 7.5 })} />
    </DeviceScreen>
    <div className="modal-note" role="status">{copyState === 'copied' ? 'Copied' : copyState === 'selected' ? 'Selected; copy it manually'
      : pms ? 'Copy the decrypted PMS' : 'Paste the private key, N and the encrypted PMS, then press Decrypt'}</div>
  </>;
}
