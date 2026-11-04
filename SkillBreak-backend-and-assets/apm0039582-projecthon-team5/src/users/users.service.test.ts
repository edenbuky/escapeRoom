import { Role } from '../config/config';
import { UserStatus } from '../database/entities/user.entity';
import { UsersService } from './users.service';

describe('UsersService', () => {
  const user = {
    id: '18a04af0-9883-4f82-92e3-f1cdf6a84ca0',
    username: 'player_1',
    email: 'player@example.com',
    displayName: 'Player One',
    role: Role.PLAYER,
    status: UserStatus.ACTIVE,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    passwordHash: 'secret-hash',
    tokenVersion: 0,
  };

  test('updates only the display name and returns the explicit user DTO', async () => {
    const queryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({ ...user }),
    };
    const transactionalRepository = {
      createQueryBuilder: jest.fn(() => queryBuilder),
      save: jest.fn(async (value) => value),
    };
    const manager = { getRepository: jest.fn(() => transactionalRepository) };
    const repository = {
      manager: {
        transaction: jest.fn((callback) => callback(manager)),
      },
    };
    const actor = {
      id: user.id,
      username: user.username,
      role: Role.PLAYER,
      familyId: '72cd1357-e24c-40ea-8221-1920889bb2aa',
      tokenVersion: 0,
    };
    const auth = {
      lockCurrentActor: jest.fn().mockResolvedValue({ user: { ...user }, now: new Date() }),
      changePassword: jest.fn(),
    };
    const service = new UsersService(repository as never, auth as never);

    const result = await service.updateMe(actor, { displayName: 'New Name' });

    expect(auth.lockCurrentActor).toHaveBeenCalledWith(manager, actor);
    expect(transactionalRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      displayName: 'New Name',
      passwordHash: 'secret-hash',
    }));
    expect(result.displayName).toBe('New Name');
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('tokenVersion');
  });
});