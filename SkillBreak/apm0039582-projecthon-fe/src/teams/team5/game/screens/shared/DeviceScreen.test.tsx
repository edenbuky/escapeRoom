import { fireEvent, render, screen } from '@testing-library/react';
import { DeviceScreen, percentBox } from './DeviceScreen';
import { submitErrorMessage } from './submit-error';

describe('shared device screen', () => {
  it('lays inputs over the device picture in percent units', () => {
    render(<DeviceScreen image="/screen.png" label="Hash cracker">
      <input className="screen-input" aria-label="Hash" style={percentBox({ left: 39.8, top: 44.1, width: 35.2, height: 6.7 })} />
    </DeviceScreen>);
    expect(screen.getByRole('group', { name: 'Hash cracker' }).querySelector('img')).toHaveAttribute('src', '/screen.png');
    expect(screen.getByLabelText('Hash')).toHaveStyle({ left: '39.8%', top: '44.1%', width: '35.2%', height: '6.7%' });
  });

  it('is the design\'s form.interactive-screen when the screen submits', () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(<DeviceScreen image="/login.png" label="Login" className="dana-desktop" onSubmit={onSubmit}>
      <button type="submit" className="screen-action" aria-label="Log In" />
    </DeviceScreen>);
    const form = screen.getByRole('form', { name: 'Login' });
    expect(form).toHaveClass('interactive-screen', 'dana-desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Log In' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('omits the height when the design gives none', () => {
    expect(percentBox({ left: 1, top: 2, width: 3 })).toEqual({ left: '1%', top: '2%', width: '3%' });
  });

  it('gives an English message for every submit error', () => {
    expect(submitErrorMessage({ error: 'unavailable' })).toBe('Game service unavailable. Try again.');
    expect(submitErrorMessage({ error: 'network' })).toBe('Connection lost. Try again.');
  });
});
