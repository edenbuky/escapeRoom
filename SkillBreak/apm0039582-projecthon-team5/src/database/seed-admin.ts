import 'reflect-metadata';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';
import { loadConfig, Role } from '../config/config';
import { User, UserStatus } from './entities/user.entity';
import { AppDataSource } from './data-source';

async function seedAdmin(dataSource: DataSource): Promise<void> {
  const username = process.env.ADMIN_USERNAME?.trim().toLowerCase();
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !/^[a-z0-9_.-]{3,32}$/.test(username)) throw new Error('ADMIN_USERNAME is invalid');
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('ADMIN_EMAIL is invalid');
  if (!password || Array.from(password).length < 15 || Array.from(password).length > 128
    || password.toLowerCase() === username) {
    throw new Error('ADMIN_PASSWORD must be 15-128 characters and must not equal ADMIN_USERNAME');
  }
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  await dataSource.transaction(async (manager) => {
    await manager.query("SET LOCAL lock_timeout = '3s'");
    await manager.query('SELECT pg_advisory_xact_lock(39582, 1)');
    const repository = manager.getRepository(User);
    const collision = await repository.createQueryBuilder('u')
      .where('u.username = :username OR u.email = :email', { username, email })
      .getOne();
    if (collision) {
      if (collision.username === username && collision.email === email
        && collision.role === Role.ADMIN && collision.status === UserStatus.ACTIVE) return;
      throw new Error('Admin seed identity collides with an existing user; refusing to modify it');
    }
    const activeAdmins = await repository.countBy({ role: Role.ADMIN, status: UserStatus.ACTIVE });
    if (activeAdmins > 0) throw new Error('An active admin already exists; refusing to create another seed admin');
    await repository.save(repository.create({
      username,
      email,
      displayName: username,
      passwordHash,
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
    }));
  });
}

async function main(): Promise<void> {
  loadConfig();
  await AppDataSource.initialize();
  try {
    await seedAdmin(AppDataSource);
    process.stdout.write('Admin seed completed.\n');
  } finally {
    await AppDataSource.destroy();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`Admin seed failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}

export { seedAdmin };