import { useState, type FormEvent } from 'react';
import { ApiError } from './api';
import { useAuth } from './AuthProvider';
import { passwordLengthError } from './auth-validation';
import './auth-form.css';

export function AuthForm() {
  const { api, unavailable, restoring, restoreError, retryRestore } = useAuth();
  const [signup, setSignup] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalidPassword = passwordLengthError(password);
    setPasswordError(invalidPassword ?? '');
    setError('');
    setNotice('');
    if (invalidPassword) return;

    setPending(true);
    try {
      if (signup) {
        await api.signup(username.trim(), email.trim(), password);
        setSignup(false);
        setPassword('');
        setNotice('Account created. Sign in to continue.');
      } else {
        await api.login(username.trim(), password);
      }
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.status : 0;
      setError(code === 401 ? 'Incorrect username or password.' : code === 409 ? 'Username or email already in use.'
        : code === 400 ? 'Check your account details.' : 'Authentication service unavailable. Try again.');
    } finally {
      setPending(false);
    }
  }

  return <section className="t5-auth-panel" aria-label="Player access">
    <h2>{signup ? 'Create account' : 'Sign in'}</h2>
    <p className="t5-auth-intro">{signup ? 'Create your account to enter the escape room.' : 'enter the virtual escape room.'}</p>
    {(unavailable || restoreError) ? <div className="t5-connection-notice" role="status">Cannot reach the server. Reconnecting... <button className="t5-text-button" type="button" onClick={retryRestore}>Retry now</button></div>
      : restoring && <p role="status">Checking your session...</p>}
    <form onSubmit={submit}>
      <label htmlFor="t5-username">Username</label>
      <input id="t5-username" name="username" autoComplete="username" required minLength={3} maxLength={32}
        pattern={signup ? '[a-zA-Z0-9_.\\-]{3,32}' : undefined} value={username}
        onChange={event => setUsername(event.target.value)} />
      {signup && <>
        <label htmlFor="t5-email">Email</label>
        <input id="t5-email" name="email" type="email" autoComplete="email" required maxLength={254}
          value={email} onChange={event => setEmail(event.target.value)} />
      </>}
      <label htmlFor="t5-password">Password</label>
      <input id="t5-password" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'}
        required aria-invalid={Boolean(passwordError)} aria-describedby={passwordError ? 't5-password-error' : undefined}
        value={password} onChange={event => { setPassword(event.target.value); setPasswordError(''); }} />
      {passwordError && <p id="t5-password-error" className="t5-auth-error" role="alert">{passwordError}</p>}
      {error && <p className="t5-auth-error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button type="submit" disabled={pending}>{pending ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</button>
    </form>
    <button className="t5-auth-switch" type="button" disabled={pending} onClick={() => {
      setSignup(!signup);
      setPasswordError('');
      setError('');
      setNotice('');
    }}>{signup ? 'Back to sign in' : 'Create an account'}</button>
  </section>;
}