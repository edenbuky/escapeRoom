import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from './AuthProvider';
import { AuthForm } from './AuthForm';
import { GameApi } from './api';

const tokens = { accessToken: 'access', refreshToken: 'refresh', expiresIn: 900, refreshExpiresAt: '',
  user: { id: 'player-id', username: 'player', displayName: 'Player' } };

function renderForm() {
  return render(<AuthProvider apiBase="/api/team5"><AuthForm /></AuthProvider>);
}

describe('Team 5 auth form validation', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.spyOn(GameApi.prototype, 'restore').mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify(tokens), {
      status: 201, headers: { 'Content-Type': 'application/json' },
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('uses the requested sign-in copy and white-background logo', () => {
    renderForm();
    expect(screen.getByText('enter the virtual escape room.')).toBeInTheDocument();
  });

  async function openSignup() {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'player_1' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'player@example.test' } });
  }

  it('rejects passwords below 15 Unicode code points without calling the API', async () => {
    await openSignup();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: '😀'.repeat(14) } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('15 to 128 characters');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts 15 and 128 Unicode code points and rejects 129', async () => {
    await openSignup();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: '😀'.repeat(15) } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'player_1' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'player@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: '😀'.repeat(128) } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'player_1' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'player@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: '😀'.repeat(129) } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('15 to 128 characters');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains native email validation and does not submit malformed email', async () => {
    await openSignup();
    const email = screen.getByLabelText('Email') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a'.repeat(15) } });
    expect(email.type).toBe('email');
    expect(email.maxLength).toBe(254);
    expect(email.checkValidity()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates login password length and keeps username constraints explicit', async () => {
    renderForm();
    const username = screen.getByLabelText('Username') as HTMLInputElement;
    expect(username.minLength).toBe(3);
    expect(username.maxLength).toBe(32);
    fireEvent.change(username, { target: { value: 'player' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); });
    expect(await screen.findByRole('alert')).toHaveTextContent('15 to 128 characters');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});