import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { DoorOpen, LoaderCircle, LogOut, Play, RotateCcw, X } from '../vendor/icons';
import { AuthProvider, useAuth } from './AuthProvider';
import { isConnectionFailure } from './api';
import { useSessionStream } from './useSessionStream';
import { RoomFrame } from './RoomFrame';
import { VictoryScreen } from './VictoryScreen';
import { AuthForm } from './AuthForm';
import type { PuzzleScreenProps } from './screens/types';
import room1Design from './room-design/room-1.design.json';
import animatedBackground from '../assets/skillbreak_animated_background.mov';
import gameSound from '../assets/game-sound.mp3';
import logo from '../assets/Logo-SkillBreak-white-background.png';
import { clearDrafts, DraftOwner } from './device-drafts';
import { useRemainingTime } from './useRemainingTime';
import './game.css';

const MUSIC_PREFERENCE_KEY = 't5-background-music';
function saveMusicPreference(enabled: boolean) {
  try { sessionStorage.setItem(MUSIC_PREFERENCE_KEY, enabled ? 'on' : 'off'); } catch { /* Storage can be unavailable. */ }
}

function GameShell({ screens }: { screens?: Partial<Record<string, ComponentType<PuzzleScreenProps>>> }) {
  const { api, auth, unavailable } = useAuth();
  const [resuming, setResuming] = useState(true);
  const [resumeFailed, setResumeFailed] = useState(false);
  const [resumeAttempt, setResumeAttempt] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const requestId = useRef<string>();
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const sound = useRef<HTMLAudioElement>(null);
  const soundStarted = useRef(false);
  const [soundOn, setSoundOn] = useState(false);
  const stream = useSessionStream(api, sessionId, auth?.accessToken, startedAt);
  const remaining = useRemainingTime(stream.view?.deadlineAt, stream.serverTime);
  const ended = !!stream.view && (stream.view.status !== 'Active' || (remaining === 0 && stream.connection === 'live' && !unavailable));
  const onStartScreen = !sessionId || stream.view?.status === 'Abandoned';
  const startSound = useCallback(() => {
    const audio = sound.current;
    if (!audio || soundStarted.current) return;
    soundStarted.current = true;
    saveMusicPreference(true);
    audio.volume = 0.35;
    void audio.play().then(() => { if (soundStarted.current) setSoundOn(true); }).catch(() => { soundStarted.current = false; });
  }, []);
  function toggleSound() {
    const audio = sound.current;
    if (!audio) return;
    if (soundStarted.current) {
      audio.pause();
      soundStarted.current = false;
      saveMusicPreference(false);
      setSoundOn(false);
    } else startSound();
  }
  const soundIcon = <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    {soundOn ? <><path d="M15 9a4 4 0 0 1 0 6" /><path d="M18 6a8 8 0 0 1 0 12" /></>
      : <path d="m16 9 5 6m0-6-5 6" />}
  </svg>;
  useEffect(() => { if (stream.view && stream.view.status !== 'Active' && sessionId) clearDrafts(sessionId); }, [stream.view?.status, sessionId]);
  useEffect(() => {
    if (!auth) { setResuming(true); setResumeFailed(false); return; }
    let alive = true;
    let pending = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setResuming(true); setResumeFailed(false); setSessionId(null);
    async function resume() {
      if (!alive || pending) return;
      clearTimeout(timer);
      pending = true;
      try {
        const id = await api.resume();
        if (alive) { setStartedAt(Date.now()); setSessionId(id); setResumeFailed(false); setResuming(false); }
      } catch (failure) {
        if (alive) {
          setResumeFailed(true);
          if (isConnectionFailure(failure)) {
            timer = setTimeout(() => { void resume(); }, delay);
            delay = Math.min(delay * 2, 10000);
          }
        }
      } finally { pending = false; }
    }
    const online = () => { if (timer) void resume(); };
    void resume();
    window.addEventListener('online', online);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener('online', online); };
  }, [api, auth?.user.id, resumeAttempt]);
  useEffect(() => { if (!auth) { setSessionId(null); requestId.current = undefined; } }, [auth]);
  async function start() {
    setPending(true); setError('');
    requestId.current ??= crypto.randomUUID();
    const ownerId = auth?.user.id;
    try {
      const id = await api.start(requestId.current);
      if (api.getAuth()?.user.id === ownerId) { setStartedAt(Date.now()); setSessionId(id); }
    }
    catch { setError('Game service unavailable. Your start request can be retried.'); }
    finally { setPending(false); }
  }
  async function abandon() {
    if (!sessionId) return;
    setPending(true); setError('');
    try { await api.abandon(sessionId); clearDrafts(sessionId); setConfirmAbandon(false); setSessionId(null); requestId.current = undefined; }
    catch { setError('Could not leave the game. Try again.'); }
    finally { setPending(false); }
  }
  return <section className="team5-game" aria-label="SkillBreak virtual escape room">
    <video className="t5-background-video" src={animatedBackground} autoPlay muted loop playsInline aria-hidden="true" />
    <audio ref={sound} src={gameSound} loop preload="auto" aria-hidden="true" />
    <header className={`topbar${auth ? '' : ' topbar--anonymous'}`}>
      {auth && <>{!onStartScreen && <div className="brand"><img className="t5-brand-logo" src={logo} alt="SkillBreak" /></div>}
        <div className="t5-room-toolbar" ref={setToolbar} />
      </>}
      <div className={`t5-account${auth ? '' : ' t5-account--anonymous'}`}>
        {auth && <><span className="t5-account-name">{auth.user.displayName || auth.user.username}</span>
          <button className="t5-icon" type="button" title="Sign out" aria-label="Sign out" onClick={() => { void api.logout().catch(() => setError('Signed out locally. Server logout could not be confirmed.')); }}><LogOut size={20} /></button>
        </>}
        <button className="t5-icon t5-sound-toggle" type="button" data-sound-toggle aria-pressed={soundOn}
          aria-label={soundOn ? 'Mute background music' : 'Play background music'}
          title={soundOn ? 'Mute background music' : 'Play background music'} onClick={toggleSound}>{soundIcon}</button>
      </div>
    </header>
    {auth && (unavailable || resumeFailed || stream.connection === 'retrying') && <div className="t5-connection-notice" role="status">
      Cannot reach the server. Reconnecting... Your displayed progress may be out of date.
      {resumeFailed && <button className="t5-text-button" type="button" onClick={() => setResumeAttempt(value => value + 1)}>Retry now</button>}
    </div>}
    {!ended && stream.view?.status === 'Active' && remaining === 0 && <p className="t5-banner" role="status">Time limit reached. Waiting for server confirmation.</p>}
    {error && <p className="t5-error t5-banner" role="alert">{error}</p>}
    {!auth ? <div className="t5-entry-scene t5-auth-scene">
      <img className="t5-entry-logo" src={logo} alt="SkillBreak" />
      <AuthForm />
    </div> : onStartScreen ? <div className="t5-entry-scene t5-start-scene">
      <img className="t5-entry-logo" src={logo} alt="SkillBreak" />
      <div className="t5-start">
        <span className="t5-start-mark" aria-hidden="true"><DoorOpen size={34} /></span>
        <span className="eyebrow">{room1Design.tag} / 45 MINUTES</span>
        <h3>Your final challenge starts here.</h3>
        <p>Investigate the room, follow the evidence, and unlock your way out.</p>
        <div className="t5-start-topics" aria-label="Skills you'll explore"><span>SQL</span><span>Git</span><span>TLS</span></div>
        {resuming && <p role="status">Restoring your game</p>}
        <button type="button" className="t5-primary" disabled={pending || resuming} onClick={() => void start()}>{pending || resuming ? <LoaderCircle className="t5-spin" size={18} /> : <Play size={18} />}Start game</button>
      </div>
    </div> : <>
      {stream.view?.status === 'Escaped' ? <VictoryScreen toolbar={toolbar} restart={() => { setSessionId(null); requestId.current = undefined; }} />
        : ended ? <div className="t5-session-state" role="status"><h2>Game Over</h2><p>Time is up</p>
        <button type="button" className="t5-primary" onClick={() => { setSessionId(null); requestId.current = undefined; }}><RotateCcw size={18} />Return to game start</button></div>
        : stream.error ? <div className="t5-session-state" role="alert"><p>{stream.error}</p><button type="button" onClick={() => { setSessionId(null); requestId.current = undefined; }}><RotateCcw size={18} />Return</button></div>
        : stream.view ? <DraftOwner.Provider value={auth.user.id}><RoomFrame key={sessionId} view={stream.view} serverTime={stream.serverTime} toolbar={toolbar}
          connection={unavailable ? 'retrying' : stream.connection} screens={screens} door={action => api.door(sessionId, stream.view!.currentRoom.key, action)}
          submit={(key, input) => remaining === 0 ? Promise.resolve({ error: 'conflict' }) : api.postInput(sessionId, key, input)} /></DraftOwner.Provider>
          : <div className="t5-session-state" role="status"><LoaderCircle className="t5-spin" size={28} /><p>Preparing your room</p></div>}
      {stream.view && stream.view.status !== 'Active' && stream.view.status !== 'Escaped' && <p className="t5-banner" role="status">Session {stream.view.status.toLowerCase()}</p>}
      {!ended && <div className="t5-leave-row">{confirmAbandon ? <><span>Leave this game?</span><button type="button" disabled={pending} onClick={() => void abandon()}>Leave game</button><button type="button" onClick={() => setConfirmAbandon(false)}>Stay</button></>
        : <button type="button" className="t5-text-button" onClick={() => setConfirmAbandon(true)}><X size={16} />Leave game</button>}</div>}
    </>}
  </section>;
}
export default function GameApp({ apiBase, screens }: { apiBase: string; screens?: Partial<Record<string, ComponentType<PuzzleScreenProps>>> }) {
  return <AuthProvider apiBase={apiBase}><GameShell screens={screens} /></AuthProvider>;
}