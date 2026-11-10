import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { fakeViews } from '../../dev/fakeViews';
import { clearDrafts } from '../../device-drafts';
import { ROOM_2_ASSETS } from '../../room-design/room-assets';
import type { PuzzleScreenProps } from '../types';
import { DoorKeypadScreen } from './DoorKeypadScreen';

const submit = vi.fn<PuzzleScreenProps['submit']>();
const openDoor = vi.fn();
const view = fakeViews().room2DoorOpen;
const doorPuzzle = () => view.currentRoom.puzzles.find(item => item.key === 'door')!;

const ui = (puzzle = doorPuzzle(), extra: Partial<PuzzleScreenProps> = {}, current = view) =>
  <DoorKeypadScreen view={current} puzzle={puzzle} submit={submit} close={vi.fn()} openDoor={openDoor} {...extra} />;
const type = (digits: string) => { for (const digit of digits) fireEvent.click(screen.getByRole('button', { name: `Digit ${digit}` })); };

beforeEach(() => { submit.mockReset().mockResolvedValue('accepted'); openDoor.mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); clearDrafts(); });

describe('door keypad', () => {
  it('renders the title, picture, four padded groups, the 12 keys at the design rects and the note', () => {
    const { container } = render(ui());
    expect(screen.getByText('Exit keypad · Enter 16 digits')).toHaveClass('modal-title');
    expect(container.querySelector('.interactive-screen.keypad-scene > img')).toHaveAttribute('src', ROOM_2_ASSETS['keypad-front']);
    expect(Array.from(container.querySelectorAll('.keypad-group')).map(group => group.textContent)).toEqual(['____', '____', '____', '____']);
    const keys = container.querySelectorAll<HTMLButtonElement>('.keypad-key');
    expect(Array.from(keys).map(key => key.textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '×', '✓']);
    expect(keys[0]).toHaveStyle({ left: '18.4%', top: '47.1%', width: '14.5%', height: '12.5%' });
    expect(keys[7]).toHaveStyle({ left: '67.7%', top: '60.9%' });
    expect(keys[11]).toHaveStyle({ left: '67.7%', top: '74.4%' });
    expect(container.querySelector('.modal-note')).toHaveTextContent('Type the 16 digits');
  });

  it('enters digits from keys and keyboard, deletes, and rejects short codes locally', () => {
    const { container } = render(ui());
    type('4000');
    fireEvent.keyDown(document, { key: '1' });
    fireEvent.keyDown(document, { key: 'Backspace' });
    fireEvent.keyDown(document, { key: '9' });
    expect(Array.from(container.querySelectorAll('.keypad-group')).map(group => group.textContent)).toEqual(['4000', '9___', '____', '____']);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm code' }));
    expect(screen.getByRole('status')).toHaveTextContent('ENTER ALL 16 DIGITS');
    expect(container.querySelector('.keypad-display')).toHaveClass('denied');
    expect(submit).not.toHaveBeenCalled();
  });

  it('accepts a pasted code with or without spaces and submits the 16 digits as an answer', async () => {
    const { container } = render(ui());
    const paste = screen.getByLabelText('Paste code');
    fireEvent.change(paste, { target: { value: ' 4000 0001 3194 1181 ' } });
    expect(Array.from(container.querySelectorAll('.keypad-group')).map(group => group.textContent)).toEqual(['4000', '0001', '3194', '1181']);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm code' })); });
    expect(submit).toHaveBeenCalledWith({ kind: 'answer', answer: '4000000131941181' });
    fireEvent.change(paste, { target: { value: '4000000131941182' } });
    await act(async () => { fireEvent.keyDown(paste, { key: 'Enter' }); });
    expect(submit).toHaveBeenLastCalledWith({ kind: 'answer', answer: '4000000131941182' });
  });

  it('shows ACCESS DENIED when the view reports a new wrongAnswer, then starts a new attempt on the next digit', () => {
    const puzzle = doorPuzzle();
    const { container, rerender } = render(ui(puzzle));
    type('4000000131941182');
    const wrong = { ...puzzle, latestResult: { commandId: 'c1', verdict: 'rejected' as const, reason: 'wrongAnswer' as const, output: '' } };
    rerender(ui(wrong));
    expect(screen.getByRole('status')).toHaveTextContent('ACCESS DENIED');
    expect(container.querySelector('.keypad-display')).toHaveClass('denied');
    type('7');
    expect(Array.from(container.querySelectorAll('.keypad-group')).map(group => group.textContent)).toEqual(['7___', '____', '____', '____']);
    expect(screen.getByRole('status')).not.toHaveTextContent('ACCESS DENIED');
  });

  it('does not show a wrongAnswer that was already in the view when the screen opened', () => {
    const puzzle = { ...doorPuzzle(), latestResult: { commandId: 'old', verdict: 'rejected' as const, reason: 'wrongAnswer' as const, output: '' } };
    render(ui(puzzle));
    expect(screen.getByRole('status')).not.toHaveTextContent('ACCESS DENIED');
  });

  it('shows ACCESS GRANTED once solved, offers Open door while the door is closed, and ignores keys', async () => {
    const solved = { ...doorPuzzle(), status: 'solved' as const };
    const closedView = structuredClone(view);
    closedView.currentRoom.doorOpenedAt = null;
    const { container } = render(ui(solved, {}, closedView));
    expect(screen.getByRole('status')).toHaveTextContent('ACCESS GRANTED');
    expect(container.querySelector('.keypad-display')).toHaveClass('granted');
    fireEvent.click(screen.getByRole('button', { name: 'Digit 1' }));
    expect(submit).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open door' })); });
    expect(openDoor).toHaveBeenCalledTimes(1);
  });

  it('hides Open door when the door is already open, and before the code is solved', () => {
    const open = structuredClone(view);
    open.currentRoom.doorOpenedAt = '2026-11-03T10:01:00Z';
    const { unmount } = render(ui({ ...doorPuzzle(), status: 'solved' }, {}, open));
    expect(screen.queryByRole('button', { name: 'Open door' })).not.toBeInTheDocument();
    unmount();
    render(ui());
    expect(screen.queryByRole('button', { name: 'Open door' })).not.toBeInTheDocument();
  });

  it('keeps every key when many keydowns arrive in one tick, and submits all 16 digits on a quick Enter', async () => {
    const { container } = render(ui());
    await act(async () => {
      for (const digit of '4000000131941181') fireEvent.keyDown(document, { key: digit });
      fireEvent.keyDown(document, { key: 'Enter' });
    });
    expect(submit).toHaveBeenCalledWith({ kind: 'answer', answer: '4000000131941181' });
    expect(Array.from(container.querySelectorAll('.keypad-group')).map(group => group.textContent)).toEqual(['4000', '0001', '3194', '1181']);
  });

  it('handles rapid Backspace presses in one tick', () => {
    const { container } = render(ui());
    act(() => {
      for (const digit of '40001') fireEvent.keyDown(document, { key: digit });
      fireEvent.keyDown(document, { key: 'Backspace' });
      fireEvent.keyDown(document, { key: 'Backspace' });
      fireEvent.keyDown(document, { key: '7' });
    });
    expect(Array.from(container.querySelectorAll('.keypad-group')).map(group => group.textContent)).toEqual(['4007', '____', '____', '____']);
  });
});
