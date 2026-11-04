import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ROOM_1_ASSETS } from '../../room-design/room-assets';
import room1Design from '../../room-design/room-1.design.json';
import { trimSingleLineInput } from '../room-1-ui.helpers';
import { DeviceScreen, percentBox } from '../shared/DeviceScreen';
import { submitErrorMessage } from '../shared/submit-error';
import type { PuzzleScreenProps } from '../types';
import { DanaDesktop } from './DanaDesktop';

const dana = room1Design.characters.dana.displayName;

export function DanaLoginScreen({ puzzle, submit, close }: PuzzleScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const passwordField = useRef<HTMLInputElement>(null);
  const rejection = puzzle.latestResult?.verdict === 'rejected' ? puzzle.latestResult.commandId : undefined;
  // Like the design's fresh form, a rejection already in the view when the screen opens is not shown;
  // a new one is shown and clears and focuses the password.
  const [rejectionAtOpen] = useState(rejection);
  const seenRejection = useRef(rejection);
  useEffect(() => {
    if (rejection && rejection !== seenRejection.current) {
      setPassword('');
      passwordField.current?.focus();
    }
    seenRejection.current = rejection;
  }, [rejection]);
  if (puzzle.status === 'solved') return <DanaDesktop openRoom={close} />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true); setSubmitError('');
    const result = await submit({ kind: 'credentials', username: trimSingleLineInput(username), password });
    setPending(false);
    if (result !== 'accepted') setSubmitError(submitErrorMessage(result));
  };
  const message = submitError || (rejection && rejection !== rejectionAtOpen ? 'Wrong username or password' : '');
  return <>
    <div className="modal-title">{dana}'s computer · Sign in</div>
    <DeviceScreen image={ROOM_1_ASSETS['login-screen']} label={`${dana}'s login screen`} onSubmit={onSubmit}>
      <input className="screen-input login-input" aria-label="Username" type="text" autoComplete="off" spellCheck={false}
        value={username} onChange={event => setUsername(event.target.value)}
        style={percentBox({ left: 39.8, top: 44.1, width: 35.2, height: 6.7 })} />
      <input ref={passwordField} className="screen-input login-input" aria-label="Password" type="password" autoComplete="off"
        value={password} onChange={event => setPassword(event.target.value)}
        style={percentBox({ left: 39.8, top: 53.5, width: 35.2, height: 6.6 })} />
      <button type="submit" className="screen-action" aria-label="Log In" disabled={pending}
        style={percentBox({ left: 39.7, top: 64.1, width: 20, height: 7.2 })} />
      {message && <div className="screen-error" role="alert">{message}</div>}
    </DeviceScreen>
    <div className="modal-note">Enter a username and password to unlock the computer</div>
  </>;
}
