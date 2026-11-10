import { render, screen } from '@testing-library/react';
import StandaloneApp from './StandaloneApp';

describe('StandaloneApp', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined))); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the game and keeps the All teams navigation', () => {
    render(<StandaloneApp />);
    expect(screen.getByRole('link', { name: /all teams/i })).toBeInTheDocument();
    expect(screen.getByText('Checking your session...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
