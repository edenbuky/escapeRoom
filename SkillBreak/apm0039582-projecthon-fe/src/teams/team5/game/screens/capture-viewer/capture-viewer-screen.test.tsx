import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { fakeViews } from '../../dev/fakeViews';
import { ROOM_2_FILE_NAME, ROOM_2_PUZZLE_KEYS } from '../../../contracts/keys';
import type { SessionView } from '../../../contracts/view';
import { CaptureViewerScreen } from './CaptureViewerScreen';
import { parseCapture } from './capture-parse';
import { DECRYPTED_CAPTURE, ENCRYPTED_CAPTURE } from './capture-fixture';

const CLIENT_RANDOM = '4089f054d2b2d135b629f4aebe147d15e1374f8dd40fc0c9593bcb6d57f60aa9';
const MODULUS = /Modulus \(N\): ([0-9a-f]+)/.exec(ENCRYPTED_CAPTURE)![1];
const PMS = /RSA Encrypted PreMaster Secret \(256 bytes\): ([0-9a-f]+)/.exec(ENCRYPTED_CAPTURE)![1];

function viewWith(content: string): SessionView {
  const view = fakeViews().room2TlsOpen;
  view.currentRoom.files = [{ name: ROOM_2_FILE_NAME, content }];
  return view;
}
function renderViewer(content: string, close = vi.fn()) {
  const view = viewWith(content);
  const puzzle = view.currentRoom.puzzles.find(item => item.key === ROOM_2_PUZZLE_KEYS.tls)!;
  render(<CaptureViewerScreen puzzle={puzzle} view={view} submit={vi.fn()} close={close} />);
  return close;
}
const details = () => document.querySelector('.pcap-detail-text') as HTMLElement;
afterEach(cleanup);

describe('capture parser', () => {
  it('reads the engine capture text into frames', () => {
    const encrypted = parseCapture(ENCRYPTED_CAPTURE);
    expect(encrypted.decrypted).toBe(false);
    expect(encrypted.packets).toHaveLength(11);
    expect(encrypted.packets.map(p => p.info)).toEqual(['Client Hello', 'Server Hello', 'Certificate', 'Server Hello Done',
      'Client Key Exchange', 'Change Cipher Spec', 'Encrypted Handshake Message', 'Change Cipher Spec', 'Encrypted Handshake Message',
      'Application Data (encrypted)', 'Application Data (encrypted)']);
    expect(encrypted.packets[0]).toMatchObject({ source: '10.20.0.14:51944', destination: '10.20.0.80:443', protocol: 'TLSv1.2', kind: 'handshake' });
    expect(encrypted.packets[1]).toMatchObject({ source: '10.20.0.80:443', destination: '10.20.0.14:51944' });
    expect(encrypted.packets[4].kind).toBe('key-exchange');
    const decrypted = parseCapture(DECRYPTED_CAPTURE);
    expect(decrypted.decrypted).toBe(true);
    expect(decrypted.packets[9]).toMatchObject({ protocol: 'HTTP', kind: 'appdata', info: 'POST /api/v2/payments HTTP/1.1 · Decrypted Application Data' });
    expect(decrypted.packets[6].info).toBe('Finished (decrypted)');
  });
});

describe('capture viewer, before the TLS solve', () => {
  it('shows the Wireshark window with row 2 selected and the cleartext handshake', () => {
    const close = renderViewer(ENCRYPTED_CAPTURE);
    expect(document.querySelector('.window-shell')).toBeTruthy();
    expect(screen.getByText('◈ Wireshark · Cibus_payment_try.pcap')).toHaveClass('window-name');
    expect(screen.getByRole('columnheader', { name: 'Protocol' })).toBeInTheDocument();
    const rows = screen.getAllByRole('button', { name: /^Packet / });
    expect(rows).toHaveLength(11);
    expect(rows[1]).toHaveClass('selected');
    expect(details()).toHaveTextContent('Handshake Type: Server Hello (2)');
    expect(screen.getByText('Frame 2 · TLSv1.2 · Server Hello')).toHaveClass('pcap-details-label');
    expect(screen.queryByText('The file has been decrypted')).toBeNull();
    expect(screen.queryByText('Decrypted HTTP')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Application Data \(encrypted\)/ })).toHaveLength(2);
    expect(document.body.textContent).not.toContain('card_number');
    fireEvent.click(screen.getByRole('button', { name: /Nathanel's computer/ }));
    expect(close).toHaveBeenCalled();
  });

  it('selects by click and by Enter and keeps the client random, N and the encrypted PMS exact and selectable', () => {
    renderViewer(ENCRYPTED_CAPTURE);
    fireEvent.click(screen.getByRole('button', { name: 'Packet 1: Client Hello' }));
    expect(details().textContent).toContain(`Client Random: ${CLIENT_RANDOM}`);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Packet 3: Certificate' }), { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Packet 3: Certificate' })).toHaveClass('selected');
    expect(details().textContent).toContain(`Modulus (N): ${MODULUS}`);
    expect(MODULUS).toHaveLength(512);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Packet 5: Client Key Exchange' }), { key: ' ' });
    expect(details().textContent).toContain(`(256 bytes): ${PMS}`);
    expect(PMS).toHaveLength(512);
    expect(details().tagName).toBe('PRE');
    expect(details().textContent).toBe(parseCapture(ENCRYPTED_CAPTURE).packets[4].detail);
    expect(details().textContent).not.toContain('…');
  });
});

describe('capture viewer, after the TLS solve', () => {
  it('shows the decrypted rows and the banner', () => {
    renderViewer(DECRYPTED_CAPTURE);
    expect(within(screen.getByRole('status')).getByText('The file has been decrypted')).toBeInTheDocument();
    expect(screen.getByText('Decrypted HTTP')).toHaveClass('pcap-tag');
    const row = screen.getByRole('button', { name: /POST \/api\/v2\/payments HTTP\/1.1 · Decrypted Application Data/ });
    expect(row).toHaveClass('appdata');
    fireEvent.click(row);
    expect(details().textContent).toContain('"card_number":"4000000131941181"');
    expect(screen.getAllByRole('button', { name: /Finished \(decrypted\)/ })).toHaveLength(2);
  });
});

describe('capture viewer, unparseable file', () => {
  it('shows the raw content in the details pane instead of an empty table', () => {
    const content = 'Frame 1: Client Hello\nsome unknown format';
    renderViewer(content);
    expect(screen.queryAllByRole('button', { name: /^Packet / })).toHaveLength(0);
    expect(details().textContent).toBe(content);
  });
});
