import { render, screen } from '@testing-library/react';
import StandaloneApp from './StandaloneApp';

describe('StandaloneApp', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined))); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the Team 5 page inside the shared layout', () => {
    render(<StandaloneApp />);
    expect(screen.getByRole('heading', { name: 'Team 5' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
