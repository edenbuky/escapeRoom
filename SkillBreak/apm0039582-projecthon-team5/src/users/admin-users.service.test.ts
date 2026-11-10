import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Role } from '../config/config';
import { RefreshFamily } from '../database/entities/refresh-family.entity';
import { User, UserStatus } from '../database/entities/user.entity';
import { AdminUsersService } from './admin-users.service';

const adminId = '18a04af0-9883-4f82-92e3-f1cdf6a84ca0';
const targetId = '72cd1357-e24c-40ea-8221-1920889bb2aa';

describe('AdminUsersService last-admin protection', () => {
  test('serializes admin mutation and refuses to demote the last active admin', async () => {
    const activeAdmin = {
      id: adminId,
      username: 'admin',
      email: 'admin@example.com',
      displayName: 'admin',
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      tokenVersion: 0,
      createdAt: new Date(),
      deletedAt: null,
    };
    const lastAdmin = {
      ...activeAdmin,
      id: targetId,
      username: 'last_admin',
      email: 'last@example.com',
    };
    const lockOrder: string[] = [];
    const repository = {
      createQueryBuilder: jest.fn(() => {
        let id = '';
        type QueryBuilderStub = {
          addSelect: jest.Mock;
          setLock: jest.Mock;
          where: jest.Mock;
          getOne: jest.Mock;
        };
        const builder = {} as QueryBuilderStub;
        builder.addSelect = jest.fn().mockReturnValue(builder);
        builder.setLock = jest.fn().mockReturnValue(builder);
        builder.where = jest.fn((_sql: string, values: { id: string }) => {
          id = values.id;
          return builder;
        });
        builder.getOne = jest.fn(async () => {
          lockOrder.push(`lock:${id}`);
          return id === adminId ? activeAdmin : lastAdmin;
        });
        return builder;
      }),
      countBy: jest.fn(async () => {
        lockOrder.push('count-admins');
        return 1;
      }),
    };
    const familyRepository = {
      findOneBy: jest.fn().mockResolvedValue({
        id: '97560abb-8752-431b-aed7-4b6ac1f98f4a',
        userId: adminId,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      }),
    };
    const manager = {
      query: jest.fn(async (query: string) => {
        if (query.includes('pg_advisory_xact_lock')) lockOrder.push('advisory');
        return [{ now: new Date() }];
      }),
      getRepository: (entity: unknown) => (entity === User ? repository : familyRepository),
    };
    const dataSource = {
      transaction: jest.fn(async (callback) => callback(manager)),
    };
    const service = new AdminUsersService(dataSource as never, repository as never);

    await expect(service.changeRole({
      id: adminId,
      username: 'admin',
      role: Role.ADMIN,
      familyId: '97560abb-8752-431b-aed7-4b6ac1f98f4a',
      tokenVersion: 0,
    }, targetId, { role: Role.PLAYER })).rejects.toBeInstanceOf(ConflictException);

    expect(lockOrder[0]).toBe('advisory');
    expect(lockOrder.indexOf('count-admins')).toBeGreaterThan(lockOrder.indexOf(`lock:${targetId}`));
    expect(lockOrder.indexOf('count-admins')).toBeGreaterThan(lockOrder.indexOf(`lock:${adminId}`));
  });

  test('rejects self-mutation before opening a transaction', async () => {
    const dataSource = { transaction: jest.fn() };
    const service = new AdminUsersService(dataSource as never, {} as never);
    await expect(service.disable({
      id: adminId,
      username: 'admin',
      role: Role.ADMIN,
      familyId: '97560abb-8752-431b-aed7-4b6ac1f98f4a',
      tokenVersion: 0,
    }, adminId)).rejects.toBeInstanceOf(ConflictException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  test('rechecks caller role after acquiring the advisory lock', async () => {
    const lockOrder: string[] = [];
    const repository = {
      createQueryBuilder: jest.fn(() => {
        let id = '';
        type QueryBuilderStub = {
          addSelect: jest.Mock;
          setLock: jest.Mock;
          where: jest.Mock;
          getOne: jest.Mock;
        };
        const builder = {} as QueryBuilderStub;
        builder.addSelect = jest.fn().mockReturnValue(builder);
        builder.setLock = jest.fn().mockReturnValue(builder);
        builder.where = jest.fn((_sql: string, values: { id: string }) => {
          id = values.id;
          return builder;
        });
        builder.getOne = jest.fn(async () => {
          lockOrder.push(`lock:${id}`);
          return id === adminId
            ? {
              id: adminId,
              username: 'admin',
              role: Role.PLAYER,
              status: UserStatus.ACTIVE,
              tokenVersion: 1,
            }
            : {
              id: targetId,
              username: 'target',
              role: Role.PLAYER,
              status: UserStatus.ACTIVE,
              tokenVersion: 0,
            };
        });
        return builder;
      }),
      countBy: jest.fn(),
    };
    const manager = {
      query: jest.fn(async (query: string) => {
        if (query.includes('pg_advisory_xact_lock')) lockOrder.push('advisory');
        return [];
      }),
      getRepository: (entity: unknown) => (entity === User ? repository : {}),
    };
    const service = new AdminUsersService({
      transaction: jest.fn(async (callback) => callback(manager)),
    } as never, repository as never);

    await expect(service.enable({
      id: adminId,
      username: 'admin',
      role: Role.ADMIN,
      familyId: '97560abb-8752-431b-aed7-4b6ac1f98f4a',
      tokenVersion: 0,
    }, targetId)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(lockOrder).toEqual(['advisory', `lock:${adminId}`, `lock:${targetId}`]);
    expect(repository.countBy).not.toHaveBeenCalled();
  });
});