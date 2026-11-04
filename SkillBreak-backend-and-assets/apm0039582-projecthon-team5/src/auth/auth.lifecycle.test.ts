import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { Role } from '../config/config';
import { RefreshFamily } from '../database/entities/refresh-family.entity';
import { RefreshToken } from '../database/entities/refresh-token.entity';
import { User, UserStatus } from '../database/entities/user.entity';
import { AuthService } from './auth.service';

jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn().mockResolvedValue('$argon2id$replacement'),
  verify: jest.fn().mockResolvedValue(true),
}));

const userId = '18a04af0-9883-4f82-92e3-f1cdf6a84ca0';
const familyId = '72cd1357-e24c-40ea-8221-1920889bb2aa';
const tokenId = '97560abb-8752-431b-aed7-4b6ac1f98f4a';
const now = new Date('2026-10-27T00:00:00.000Z');

function makeService(transaction: jest.Mock, queryBuilder?: jest.Mock) {
  process.env.JWT_ACCESS_SECRET = Buffer.alloc(32, 7).toString('base64');
  process.env.DB_HOST = 'localhost';
  process.env.DB_USER = 'escape';
  process.env.DB_PASSWORD = 'password';
  process.env.DB_NAME = 'escape_room';
  const dataSource = {
    transaction,
    createQueryBuilder: queryBuilder,
  };
  return new AuthService(dataSource as never, {} as never);
}

describe('AuthService credential lifecycle', () => {
  test('commits family revocation after a used refresh token is replayed', async () => {
    let committed = false;
    const user = { id: userId, status: UserStatus.ACTIVE };
    const token = { id: tokenId, familyId, usedAt: new Date(now.getTime() - 1000) };
    const family = {
      id: familyId,
      userId,
      createdAt: new Date(now.getTime() - 10_000),
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: null,
    };
    const userBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(user),
    };
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === User) return { createQueryBuilder: () => userBuilder };
        if (entity === RefreshToken) return { findOneBy: jest.fn().mockResolvedValue(token) };
        return { findOneBy: jest.fn().mockResolvedValue(family), save: jest.fn(async (value) => value) };
      },
      query: jest.fn().mockResolvedValue([{ now }]),
    };
    const transaction = jest.fn(async (callback) => {
      const result = await callback(manager);
      committed = true;
      return result;
    });
    const locatorBuilder = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ id: tokenId, userId }),
    };
    const service = makeService(transaction, jest.fn(() => locatorBuilder));

    await expect(service.refresh({ refreshToken: 'A'.repeat(43) }))
      .rejects.toBeInstanceOf(UnauthorizedException);

    expect(committed).toBe(true);
    expect(family.revokedAt).toEqual(now);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  test('logout-all increments version and revokes every active family transactionally', async () => {
    const user = {
      id: userId,
      username: 'admin',
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      tokenVersion: 4,
      passwordHash: '$argon2id$hash',
    };
    const family = {
      id: familyId,
      userId,
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: null,
    };
    const userBuilder = {
      addSelect: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(user),
    };
    const revokeBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 2 }),
    };
    const userRepository = {
      createQueryBuilder: () => userBuilder,
      save: jest.fn(async (value) => value),
    };
    const familyRepository = {
      findOneBy: jest.fn().mockResolvedValue(family),
      createQueryBuilder: () => revokeBuilder,
    };
    const manager = {
      getRepository: (entity: unknown) => (entity === User ? userRepository : familyRepository),
      query: jest.fn().mockResolvedValue([{ now }]),
    };
    const transaction = jest.fn(async (callback) => callback(manager));
    const service = makeService(transaction);

    await service.logoutAll({
      id: userId,
      username: 'admin',
      role: Role.ADMIN,
      familyId,
      tokenVersion: 4,
    });

    expect(user.tokenVersion).toBe(5);
    expect(userRepository.save).toHaveBeenCalledWith(user);
    expect(revokeBuilder.execute).toHaveBeenCalled();
  });

  test('changes password only after current-password verification and revokes all families', async () => {
    const user = {
      id: userId,
      username: 'admin',
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      tokenVersion: 4,
      passwordHash: '$argon2id$current',
    };
    const family = {
      id: familyId,
      userId,
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: null,
    };
    const userBuilder = {
      addSelect: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(user),
    };
    const userRepository = {
      createQueryBuilder: jest.fn(() => userBuilder),
      save: jest.fn(async (value) => value),
    };
    const revokeBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const familyRepository = {
      findOneBy: jest.fn().mockResolvedValue(family),
      createQueryBuilder: jest.fn(() => revokeBuilder),
    };
    const manager = {
      getRepository: (entity: unknown) => (entity === User ? userRepository : familyRepository),
      query: jest.fn().mockResolvedValue([{ now }]),
    };
    const snapshotBuilder = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({ ...user }),
    };
    const users = { createQueryBuilder: jest.fn(() => snapshotBuilder) };
    const transaction = jest.fn(async (callback) => callback(manager));
    const service = makeService(transaction);
    (service as unknown as { users: typeof users }).users = users as never;

    await service.changePassword({
      id: userId,
      username: 'admin',
      role: Role.ADMIN,
      familyId,
      tokenVersion: 4,
    }, {
      currentPassword: 'current-password-is-long',
      newPassword: 'replacement-password-long',
    });

    expect(argon2.verify).toHaveBeenCalledWith('$argon2id$current', 'current-password-is-long');
    expect(user.passwordHash).toBe('$argon2id$replacement');
    expect(user.tokenVersion).toBe(5);
    expect(revokeBuilder.execute).toHaveBeenCalled();
  });

  test('rejects a wrong current password without starting a transaction', async () => {
    const snapshotBuilder = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        username: 'admin',
        status: UserStatus.ACTIVE,
        passwordHash: '$argon2id$current',
      }),
    };
    const transaction = jest.fn();
    const service = makeService(transaction);
    (service as unknown as { users: unknown }).users = {
      createQueryBuilder: jest.fn(() => snapshotBuilder),
    };
    (argon2.verify as jest.Mock).mockResolvedValueOnce(false);

    await expect(service.changePassword({
      id: userId,
      username: 'admin',
      role: Role.ADMIN,
      familyId,
      tokenVersion: 4,
    }, {
      currentPassword: 'wrong-current-password',
      newPassword: 'replacement-password-long',
    })).rejects.toBeInstanceOf(UnauthorizedException);

    expect(transaction).not.toHaveBeenCalled();
  });
});