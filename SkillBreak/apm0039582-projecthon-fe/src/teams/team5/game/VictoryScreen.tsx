import { createPortal } from 'react-dom';
import { RotateCcw } from '../vendor/icons';
import { ROOM_2_ASSETS } from './room-design/room-assets';
import './victory.css';

/** The final room (design showRoom for the victory room): the picture as it is, the tag and the banner. */
export function VictoryScreen({ toolbar, restart }: { toolbar: HTMLElement | null; restart: () => void }) {
  return <>
    {toolbar && createPortal(<div className="room-count" aria-live="polite">
      <span>Victory room</span>
      <div className="room-dots" aria-hidden="true">{[1, 2, 3].map(room => <span key={room} className={`dot ${room === 3 ? 'active' : ''}`} />)}</div>
      <span>03 / 03</span>
    </div>, toolbar)}
    <section className="stage-frame" aria-label="Victory room" role="status">
      <div className="stage" data-room="victory">
        <img className="room-bg" src={ROOM_2_ASSETS.victory} alt="" draggable={false} />
        <span className="room-tag">ROOM 03 · MISSION COMPLETE</span>
        <div className="victory-banner">🎉 Welcome to the team!</div>
      </div>
    </section>
    <div className="t5-session-state t5-victory-actions">
      <button type="button" className="t5-primary" onClick={restart}><RotateCcw size={18} />Return to game start</button>
    </div>
  </>;
}
