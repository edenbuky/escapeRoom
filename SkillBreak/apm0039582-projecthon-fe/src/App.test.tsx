import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import App from './App';
import { TEAMS, REFERENCE_SERVICE } from './teams';
import { TEAM_PAGES } from './teams/registry';

function setPath(pathname: string) {
  window.history.pushState({}, '', pathname);
}

beforeEach(() => {
  setPath('/');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ status: 'ok' }),
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('App routing', () => {
  it('puts the branded Team 7 product before collapsed development diagnostics', async () => {
    setPath('/team7');
    render(<App />);
    expect(screen.getByRole('img', { name: 'AT&T' })).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'New Event' });
    const summary = screen.getByText('Development diagnostics');
    const details = summary.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(form.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(summary);
    expect(details).toHaveAttribute('open');
    expect(screen.getByText('/api/team7')).toBeVisible();
    await screen.findByText('Connected');
  });
  it('opts only Team 7 into the wide shell and keeps navigation, diagnostics and composer', async () => {
    setPath('/team7');
    render(<App />);
    expect(screen.getByRole('main')).toHaveClass('app', 'app--team7');
    expect(screen.getByRole('form', { name: 'New Event' })).toBeInTheDocument();
    expect(screen.getByText('/api/team7')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /all teams/i })).toHaveAttribute('href', '/');
    await screen.findByText('Connected');
  });

  it.each(['/', '/team1', '/team2', '/team3', '/team4', '/team5', '/team6', '/tdp-2026', '/team99'])('keeps the original shell on %s', async (path) => {
    setPath(path); render(<App />);
    expect(screen.getByRole('main')).toHaveClass('app');
    expect(screen.getByRole('main')).not.toHaveClass('app--team7');
    if (/^\/team[1-6]$/.test(path)) await screen.findByText('Connected');
  });

  it('keeps Team 7 composer visible when shared backend diagnostics fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unreachable')));
    setPath('/team7'); render(<App />);
    await screen.findByText(/Unreachable/);
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Draft' })).toBeInTheDocument();
  });
  it('renders the home page with a link per team', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /projecthon/i })).toBeInTheDocument();
    expect(TEAMS).toHaveLength(8);
    TEAMS.forEach((team) => {
      expect(screen.getByRole('link', { name: team.name })).toHaveAttribute('href', team.path);
    });
  });

  it('includes the tdp-2026 reference service routed to its own backend', () => {
    expect(REFERENCE_SERVICE.service).toBe('tdp-2026');
    expect(REFERENCE_SERVICE.apiPath).toBe('/api/tdp-2026');
    expect(TEAM_PAGES['tdp-2026']).toBeDefined();
  });

  it('has a dedicated page component registered for every team', () => {
    TEAMS.forEach((team) => expect(TEAM_PAGES[team.id]).toBeDefined());
  });

  it.each(TEAMS.filter((t) => t.id !== 'tdp-2026'))(
    'renders $name page at $path and calls its backend',
    async (team) => {
      setPath(team.path);
      render(<App />);

      expect(screen.getByRole('heading', { name: team.name })).toBeInTheDocument();
      expect(screen.getByText(team.apiPath)).toBeInTheDocument();

      await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
      expect(fetch).toHaveBeenCalledWith(team.apiPath, expect.anything());
    },
  );

  it('renders the tdp-2026 fun page with a poke button', () => {
    setPath('/tdp-2026');
    render(<App />);
    expect(screen.getByRole('heading', { name: /tdp\s*2026/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /poke the backend/i })).toBeInTheDocument();
    expect(screen.getByText('/api/tdp-2026')).toBeInTheDocument();
  });

  it('shows an error when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    setPath('/team1');
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Unreachable/)).toBeInTheDocument());
  });

  it('renders a not-found page for an unknown route', () => {
    setPath('/team99');
    render(<App />);
    expect(screen.getByRole('heading', { name: /page not found/i })).toBeInTheDocument();
  });
});
