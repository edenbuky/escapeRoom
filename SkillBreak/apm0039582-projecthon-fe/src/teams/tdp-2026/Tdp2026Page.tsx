import { useEffect, useMemo, useState } from 'react';
import type { TeamService } from '../../teams';
import { fetchFromTeamApi } from '../../api/teamApi';
import './tdp2026.css';

const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs. 🐛',
  'There are 10 kinds of people: those who read binary and those who don’t. 🤓',
  'A SQL query walks into a bar, walks up to two tables and asks: "Can I JOIN you?" 🍺',
  'It works on my machine. ¯\\_(ツ)_/¯',
  '99 little bugs in the code… patch one down… 127 little bugs in the code. 🔧',
  'To understand recursion, first you must understand recursion. 🔁',
  'I would tell you a UDP joke, but you might not get it. 📡',
  'My code doesn’t have bugs. It just develops random unexpected features. ✨',
];

const FACES = ['🚀', '🎉', '🤖', '🛰️', '👾', '🦾', '⚡', '🔥', '🌈', '🍩'];

interface Props {
  team: TeamService;
  onNavigate: (to: string) => void;
}

/** A deliberately silly page that pokes the tdp-2026 backend and shows off the full chain. */
export default function Tdp2026Page({ team, onNavigate }: Props) {
  const [faceIndex, setFaceIndex] = useState(0);
  const [pokes, setPokes] = useState(0);
  const [reply, setReply] = useState<string>('');
  const [pinging, setPinging] = useState(false);
  const [db, setDb] = useState<{ ok: boolean; text: string }>({ ok: false, text: 'not checked yet' });

  const joke = useMemo(() => JOKES[pokes % JOKES.length], [pokes]);
  const face = FACES[faceIndex % FACES.length];

  useEffect(() => {
    // Cosmetic mascot cycle — deterministic, not a security-sensitive value.
    const id = setInterval(() => {
      setFaceIndex((i) => i + 1);
    }, 700);
    return () => clearInterval(id);
  }, []);

  async function poke() {
    setPinging(true);
    setPokes((n) => n + 1);
    try {
      const info = await fetchFromTeamApi<{ message?: string; hostname?: string }>(team.apiPath, '/');
      setReply(
        info.message
          ? `${info.message}  (from pod ${info.hostname ?? '?'})`
          : JSON.stringify(info),
      );
    } catch (err) {
      setReply(`backend said nothing 😴 (${(err as Error).message})`);
    } finally {
      setPinging(false);
    }
  }

  async function checkDb() {
    setDb({ ok: false, text: 'checking…' });
    try {
      const res = await fetchFromTeamApi<{ db?: { connected?: boolean; database?: string; latencyMs?: number } }>(
        team.apiPath,
        '/db',
      );
      if (res.db?.connected) {
        setDb({
          ok: true,
          text: `connected to ${res.db.database} in ${res.db.latencyMs}ms 🎯`,
        });
      } else {
        setDb({ ok: false, text: 'backend reached, database said no 🙅' });
      }
    } catch (err) {
      setDb({ ok: false, text: `no database today 🌧️ (${(err as Error).message})` });
    }
  }

  return (
    <section className="tdp-page">
      <a
        className="tdp-back"
        href="/"
        onClick={(e) => {
          e.preventDefault();
          onNavigate('/');
        }}
      >
        ← back to the boring list
      </a>

      <div className={`tdp-hero ${pinging ? 'wobble' : ''}`}>
        <span className="tdp-face" role="img" aria-label="mascot">
          {face}
        </span>
        <h1>TDP&nbsp;2026</h1>
        <p className="tdp-tagline">the microservice that just wants to say hi</p>
      </div>

      <button className="tdp-btn" onClick={poke} disabled={pinging}>
        {pinging ? 'poking…' : 'Poke the backend'}
      </button>

      <div className="tdp-counter">
        pokes delivered: <strong>{pokes}</strong>
      </div>

      {reply && <div className="tdp-reply">🗣️ {reply}</div>}

      <p className="tdp-joke">{joke}</p>

      <div className="tdp-db">
        <button className="tdp-btn tdp-btn-ghost" onClick={checkDb}>
          Ask the database how it’s doing
        </button>
        <span className={db.ok ? 'tdp-db-ok' : 'tdp-db-meh'}>{db.text}</span>
      </div>

      <footer className="tdp-foot">
        served via <code>{team.apiPath}</code> → <code>{team.service}</code> → PostgreSQL
      </footer>
    </section>
  );
}
