/**
 * Parses the room file the engine sends (game-engine room2-scenario capture text):
 *   <file name>\nCapture: <client ip:port> (client) <-> <server ip:port> (<host>)\n\n
 *   Frame N | <Client -> Server|Server -> Client> | TLSv1.2 Record Layer: <summary>\n  <detail lines, 2-space indented>\n\n ...
 * Nothing is added to the packet details: they are the frame's own lines, so long hex values stay exact.
 */
export type PacketKind = 'handshake' | 'key-exchange' | 'appdata' | 'other';
export interface Packet {
  no: number; time: string; source: string; destination: string; protocol: string; info: string; kind: PacketKind; detail: string;
}
export interface ParsedCapture { packets: Packet[]; decrypted: boolean }

const FRAME = /^Frame (\d+) \| (Client|Server) -> (?:Server|Client) \| (.*)$/;

function summarize(head: string, lines: string[]): { protocol: string; info: string; kind: PacketKind } {
  const record = head.replace(/^TLSv1\.2 Record Layer: /, '');
  const protocol = 'TLSv1.2';
  const decryptedHandshake = lines.find(line => line.startsWith('Decrypted Handshake Message: '));
  const decryptedData = lines.findIndex(line => line.startsWith('Decrypted Application Data'));
  if (decryptedData >= 0) {
    const first = lines.slice(decryptedData + 1).map(line => line.trim()).find(Boolean) ?? 'Application Data';
    return { protocol: 'HTTP', info: `${first} · Decrypted Application Data`, kind: 'appdata' };
  }
  if (decryptedHandshake) return { protocol, info: `${decryptedHandshake.slice('Decrypted Handshake Message: '.length).replace(/ \(.*\)$/, '')} (decrypted)`, kind: 'handshake' };
  if (record === 'Change Cipher Spec') return { protocol, info: record, kind: 'key-exchange' };
  if (record === 'Application Data') return { protocol, info: 'Application Data (encrypted)', kind: 'other' };
  const handshake = record.replace(/^Handshake Protocol: /, '');
  return { protocol, info: handshake, kind: /Key Exchange/.test(handshake) ? 'key-exchange' : 'handshake' };
}

export function parseCapture(content: string): ParsedCapture {
  const rows = content.split('\n');
  const captureLine = rows.find(line => line.startsWith('Capture: '));
  const client = captureLine?.match(/(\S+) \(client\)/)?.[1] ?? '';
  const server = captureLine?.match(/<-> (\S+)/)?.[1] ?? '';
  const packets: Packet[] = [];
  let current: { no: number; from: 'Client' | 'Server'; head: string; lines: string[] } | undefined;
  const finish = () => {
    if (!current) return;
    while (current.lines.length && current.lines[current.lines.length - 1] === '') current.lines.pop();
    const detail = current.lines.map(line => line.replace(/^ {2}/, ''));
    const sent = current.from === 'Client';
    packets.push({ no: current.no, time: ((current.no - 1) * 0.037).toFixed(6), source: sent ? client : server,
      destination: sent ? server : client, ...summarize(current.head, detail), detail: detail.join('\n') });
    current = undefined;
  };
  for (const line of rows) {
    const frame = line.match(FRAME);
    if (frame) { finish(); current = { no: Number(frame[1]), from: frame[2] as 'Client' | 'Server', head: frame[3], lines: [] }; }
    else if (current) current.lines.push(line);
  }
  finish();
  return { packets, decrypted: packets.some(packet => packet.protocol === 'HTTP') };
}
