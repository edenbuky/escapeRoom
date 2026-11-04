import { useEffect, useRef, useState, type ComponentType } from 'react';
import { DoorOpen, LoaderCircle, LogOut, Play, RotateCcw, X } from '../vendor/icons';
import { AuthProvider, useAuth } from './AuthProvider';
import { useSessionStream } from './useSessionStream';
import { RoomFrame } from './RoomFrame';
import { AuthForm } from './AuthForm';
import type { PuzzleScreenProps } from './screens/types';
import room1Design from './room-design/room-1.design.json';
import entryBackground from '../assets/entry-background.png';
import './game.css';

function GameShell({ screens }: { screens?: Partial<Record<string, ComponentType<PuzzleScreenProps>>> }) {
  const { api, auth } = useAuth();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const requestId = useRef<string>();
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const stream = useSessionStream(api, sessionId, auth?.accessToken, startedAt);
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
    try { await api.abandon(sessionId); setConfirmAbandon(false); setSessionId(null); requestId.current = undefined; }
    catch { setError('Could not leave the game. Try again.'); }
    finally { setPending(false); }
  }
  return <section className="team5-game" aria-label="SkillBreak virtual escape room">
    <header className="topbar"><div className="brand"><div className="brand-mark" aria-hidden="true">T</div><div><p className="eyebrow">SkillBreak / Virtual escape room</p><h2>{auth ? 'The Last TDP Escape Room' : 'Welcome To SkillBreak'}</h2></div></div>
      <div className="t5-room-toolbar" ref={setToolbar} />
      {auth && <div className="t5-account"><span>{auth.user.displayName || auth.user.username}</span>
        <button className="t5-icon" type="button" title="Sign out" aria-label="Sign out" onClick={() => { void api.logout().catch(() => setError('Signed out locally. Server logout could not be confirmed.')); }}><LogOut size={20} /></button>
      </div>}
    </header>
    {error && <p className="t5-error t5-banner" role="alert">{error}</p>}
    {!auth ? <div className="t5-entry-scene t5-auth-scene">
      <img src={entryBackground} alt="" />
      <AuthForm />
    </div> : !sessionId ? <div className="t5-entry-scene t5-start-scene">
      <img src={entryBackground} alt="" />
      <div className="t5-start">
        <span className="t5-start-mark" aria-hidden="true"><DoorOpen size={34} /></span>
        <span className="eyebrow">{room1Design.tag} / 45 MINUTES</span>
        <h3>Your final challenge starts here.</h3>
        <p>Investigate the room, follow the evidence, and unlock your way out.</p>
        <div className="t5-start-topics" aria-label="Skills you'll explore"><span>SQL</span><span>Git</span><span>TLS</span></div>
        <button type="button" className="t5-primary" disabled={pending} onClick={() => void start()}>{pending ? <LoaderCircle className="t5-spin" size={18} /> : <Play size={18} />}Start game</button>
      </div>
    </div> : <>
      {stream.error ? <div className="t5-session-state" role="alert"><p>{stream.error}</p><button type="button" onClick={() => { setSessionId(null); requestId.current = undefined; }}><RotateCcw size={18} />Return</button></div>
        : stream.view ? <RoomFrame key={sessionId} view={stream.view} serverTime={stream.serverTime} toolbar={toolbar}
          connection={stream.connection} screens={screens} submit={(key, input) => api.postInput(sessionId, key, input)} />
          : <div className="t5-session-state" role="status"><LoaderCircle className="t5-spin" size={28} /><p>Preparing your room</p></div>}
      {stream.view && stream.view.status !== 'Active' && <p className="t5-banner" role="status">Session {stream.view.status.toLowerCase()}</p>}
      <div className="t5-leave-row">{confirmAbandon ? <><span>Leave this game?</span><button type="button" disabled={pending} onClick={() => void abandon()}>Leave game</button><button type="button" onClick={() => setConfirmAbandon(false)}>Stay</button></>
        : <button type="button" className="t5-text-button" onClick={() => setConfirmAbandon(true)}><X size={16} />Leave game</button>}</div>
    </>}
  </section>;
}
export default function GameApp({ apiBase, screens }: { apiBase: string; screens?: Partial<Record<string, ComponentType<PuzzleScreenProps>>> }) {
  return <AuthProvider apiBase={apiBase}><GameShell screens={screens} /></AuthProvider>;
}