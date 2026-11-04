import { ExecutionContext, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { Role } from '../config/config';
import { AuthService } from './auth.service';
import { JwtAuthGuard, RolesGuard } from './jwt-auth.guard';

const signingKey = Buffer.alloc(32, 9);
const userId = '18a04af0-9883-4f82-92e3-f1cdf6a84ca0';
const familyId = '72cd1357-e24c-40ea-8221-1920889bb2aa';

function makeContext(token: string, user?: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` }, user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function makeToken(key = signingKey): string {
  return jwt.sign({ fid: familyId, ver: 0 }, key, {
    algorithm: 'HS256',
    subject: userId,
    issuer: 'escape-room-api',
    audience: 'escape-room-client',
    expiresIn: 900,
  });
}

describe('access and role guards', () => {
  const account = { id: userId, username: 'player_1', role: Role.PLAYER };
  const query = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(account),
  };
  const dataSource = { createQueryBuilder: jest.fn(() => query) };
  const auth = {
    jwtConfig: {
      secret: signingKey,
      ttlSeconds: 900,
      issuer: 'escape-room-api',
      audience: 'escape-room-client',
      refreshTtlDays: 7,
    },
  };
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue([Role.ADMIN]),
  };
  const jwtGuard = new JwtAuthGuard(dataSource as never, auth as AuthService, reflector as unknown as Reflector);
  const roleGuard = new RolesGuard(reflector as unknown as Reflector);

  beforeEach(() => {
    jest.clearAllMocks();
    query.getRawOne.mockResolvedValue(account);
  });

  test('accepts a valid token and loads the database user', async () => {
    const requestContext = makeContext(makeToken());
    await expect(jwtGuard.canActivate(requestContext)).resolves.toBe(true);
    expect(query.getRawOne).toHaveBeenCalled();
  });

  test('rejects invalid signatures before database access', async () => {
    await expect(jwtGuard.canActivate(makeContext(makeToken(Buffer.alloc(32, 4)))))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(query.getRawOne).not.toHaveBeenCalled();
  });

  test('logs the account lookup failure name and code, never the message', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    query.getRawOne.mockRejectedValue(Object.assign(new Error('private connection string'), { code: '57P01' }));
    await expect(jwtGuard.canActivate(makeContext(makeToken()))).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(warn).toHaveBeenCalledWith('Account lookup failed: Error code=57P01');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
    warn.mockRestore();
  });

  test('denies a valid player token on an admin route for Nest to return 403', async () => {
    const requestContext = makeContext(makeToken(), account);
    expect(roleGuard.canActivate(requestContext)).toBe(false);
  });
});