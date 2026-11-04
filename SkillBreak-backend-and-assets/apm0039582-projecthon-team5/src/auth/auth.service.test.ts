import { ConflictException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { Role } from '../config/config';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/auth.dto';

jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn().mockResolvedValue('$argon2id$test-hash'),
}));

describe('AuthService.signup', () => {
  const savedUser = {
    id: '18a04af0-9883-4f82-92e3-f1cdf6a84ca0',
    username: 'player_1',
    email: 'player@example.com',
    displayName: 'player_1',
    role: Role.PLAYER,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    passwordHash: '$argon2id$test-hash',
    tokenVersion: 0,
    status: 'active',
  };
  let users: { create: jest.Mock; save: jest.Mock };
  let service: AuthService;

  beforeEach(() => {
    process.env.JWT_ACCESS_SECRET = Buffer.alloc(32, 7).toString('base64');
    process.env.DB_HOST = 'localhost';
    process.env.DB_USER = 'escape';
    process.env.DB_PASSWORD = 'password';
    process.env.DB_NAME = 'escape_room';
    users = {
      create: jest.fn((user) => user),
      save: jest.fn().mockResolvedValue(savedUser),
    };
    service = new AuthService({} as never, users as never);
    jest.clearAllMocks();
    (argon2.hash as jest.Mock).mockResolvedValue('$argon2id$test-hash');
  });

  test('normalizes identity and returns an explicit player DTO without credential data', async () => {
    const result = await service.signup({
      username: ' Player_1 ',
      email: 'PLAYER@EXAMPLE.COM ',
      password: 'a strong passphrase',
    } as SignupDto);

    expect(users.create).toHaveBeenCalledWith(expect.objectContaining({
      username: 'player_1',
      email: 'player@example.com',
      role: Role.PLAYER,
      passwordHash: '$argon2id$test-hash',
    }));
    expect(result).toEqual({
      id: savedUser.id,
      username: savedUser.username,
      email: savedUser.email,
      displayName: savedUser.displayName,
      role: Role.PLAYER,
      createdAt: savedUser.createdAt.toISOString(),
    });
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('tokenVersion');
  });

  test('rejects a password matching the normalized username', async () => {
    await expect(service.signup({
      username: 'player_1',
      email: 'player@example.com',
      password: 'PLAYER_1',
    } as SignupDto)).rejects.toBeInstanceOf(ConflictException);
    expect(users.save).not.toHaveBeenCalled();
  });
});