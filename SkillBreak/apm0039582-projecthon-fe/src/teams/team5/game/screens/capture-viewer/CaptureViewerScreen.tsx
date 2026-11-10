import { useState, type KeyboardEvent } from 'react';
import { ROOM_2_FILE_NAME } from '../../../contracts/keys';
import type { PuzzleScreenProps } from '../types';
import { parseCapture } from './capture-parse';
import './capture-viewer.css';

/**
 * Wireshark-style window for the room's capture file (design showPacketCapture). It only displays the file
 * content the engine put in the session view: the encrypted capture, or the decrypted one after the TLS solve.
 */
export function CaptureViewerScreen({ view, close }: PuzzleScreenProps) {
  const file = view.currentRoom.files.find(candidate => candidate.name === ROOM_2_FILE_NAME);
  const { packets, decrypted } = parseCapture(file?.content ?? '');
  const raw = packets.length === 0 && Boolean(file?.content);
  const [selected, setSelected] = useState(1);
  const packet = packets[Math.min(selected, packets.length - 1)];
  const press = (index: number) => (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(index); }
  };
  return <div className="window-shell capture-window">
    <div className="window-header">
      <button type="button" className="window-back" onClick={close}>{'←'} Nathanel's computer</button>
      <span className="window-name">{`◈ Wireshark · ${ROOM_2_FILE_NAME}`}</span>
      <div className="pcap-tags">
        <span className="pcap-tag handshake">TLS Handshake</span>
        {decrypted && <span className="pcap-tag appdata">Decrypted HTTP</span>}
      </div>
    </div>
    <div className="window-subtitle">{decrypted ? 'Decrypted PCAP' : 'Captured PCAP'} {'·'} click a row to see the packet contents</div>
    {decrypted && <div className="pcap-banner" role="status">The file has been decrypted</div>}
    <div className="pcap-table-wrap">
      <table className="pcap-table">
        <thead><tr><th>No.</th><th>Time</th><th>Source</th><th>Destination</th><th>Protocol</th><th>Info</th></tr></thead>
        <tbody>{packets.map((item, index) => <tr key={item.no} className={`${item.kind}${index === selected ? ' selected' : ''}`}
          tabIndex={0} role="button" aria-label={`Packet ${item.no}: ${item.info}`} aria-pressed={index === selected}
          onClick={() => setSelected(index)} onKeyDown={press(index)}>
          <td>{item.no}</td><td>{item.time}</td><td>{item.source}</td><td>{item.destination}</td><td>{item.protocol}</td><td>{item.info}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className="pcap-details">
      <div className="pcap-details-label">{raw ? ROOM_2_FILE_NAME : packet ? `Frame ${packet.no} · ${packet.protocol} · ${packet.info}` : 'Packet details'}</div>
      <pre className="pcap-detail-text">{raw ? file!.content : packet?.detail ?? ''}</pre>
    </div>
    <div className="window-footer">Simulation data for the game only {'·'} the card details are fictitious</div>
  </div>;
}
