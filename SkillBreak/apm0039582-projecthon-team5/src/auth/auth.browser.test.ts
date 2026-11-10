import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { AccessTokenDto } from './dto/auth.dto';

jest.mock('./auth.service', () => ({ AuthService: class {} }));

const tokens = { accessToken: 'access', refreshToken: 'r'.repeat(43), refreshExpiresAt: '2026-12-01T00:00:00Z' } as AccessTokenDto;
function request(header = '1') {
  return { get: () => header, secure: true, headers: { cookie: `other=value; t5-refresh=${tokens.refreshToken}` } } as unknown as Request;
}
function response() { return { cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn() } as unknown as Response; }
test('browser refresh reads HttpOnly credential and never exposes it in JSON', async () => {
  const refresh = jest.fn().mockResolvedValue(tokens);
  const controller = new AuthController({ refresh } as unknown as AuthService);
  const reply = response();
  expect(await controller.browserRefresh(request(), reply)).toMatchObject({ accessToken: 'access', refreshToken: '' });
  expect(refresh).toHaveBeenCalledWith({ refreshToken: tokens.refreshToken });
  expect(reply.cookie).toHaveBeenCalledWith('t5-refresh', tokens.refreshToken,
    expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'strict', path: '/' }));
  await expect(controller.browserRefresh(request(''), reply)).rejects.toThrow();
  expect(refresh).toHaveBeenCalledTimes(1);
});
test('browser logout revokes credential and clears the cookie', async () => {
  const logout = jest.fn().mockResolvedValue(undefined);
  const controller = new AuthController({ logout } as unknown as AuthService);
  const reply = response();
  await controller.browserLogout(request(), reply);
  expect(logout).toHaveBeenCalledWith({ refreshToken: tokens.refreshToken });
  expect(reply.clearCookie).toHaveBeenCalledWith('t5-refresh', expect.objectContaining({ httpOnly: true, path: '/' }));
});