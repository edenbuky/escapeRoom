import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, QueryFailedError, Repository } from 'typeorm';
import { Role } from '../config/config';
import { RefreshFamily } from '../database/entities/refresh-family.entity';
import { User, UserStatus } from '../database/entities/user.entity';
import {
  AdminCreateUserDto,
  AdminUserDto,
  AdminUserQueryDto,
  AdminUsersPageDto,
  ChangeRoleDto,
  UserDto,
} from '../auth/dto/auth.dto';
import { AuthenticatedActor } from '../auth/auth.service';

const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

function toAdminUserDto(user: User): AdminUserDto {
  return {
    ...toUserDto(user),
    status: user.status,
    deletedAt: user.deletedAt?.toISOString() ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof QueryFailedError
    && typeof error.driverError === 'object'
    && error.driverError !== null
    && 'code' in error.driverError
    && error.driverError.code === '23505';
}

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async list(query: AdminUserQueryDto): Promise<AdminUsersPageDto> {
    const builder = this.users.createQueryBuilder('u');
    if (query.role) builder.andWhere('u.role = :role', { role: query.role });
    if (query.status) builder.andWhere('u.status = :status', { status: query.status });
    if (query.q) {
      const prefix = `${query.q.trim().toLowerCase().replace(/[!%_]/g, '!$&')}%`;
      builder.andWhere("(u.username LIKE :prefix ESCAPE '!' OR u.email LIKE :prefix ESCAPE '!')", { prefix });
    }
    const [users, total] = await builder
      .orderBy('u.createdAt', 'ASC')
      .addOrderBy('u.id', 'ASC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount();
    return { items: users.map(toAdminUserDto), page: query.page, pageSize: query.pageSize, total };
  }

  async get(id: string): Promise<AdminUserDto> {
    const user = await this.users.findOneBy({ id });
    if (!user) throw new NotFoundException('User not found');
    return toAdminUserDto(user);
  }

  async create(actor: AuthenticatedActor, input: AdminCreateUserDto): Promise<AdminUserDto> {
    const username = input.username.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();
    if (input.password.toLowerCase() === username) {
      throw new ConflictException('Password must not equal username');
    }
    const passwordHash = await argon2.hash(input.password, ARGON_OPTIONS);
    try {
      const created = await this.adminTransaction(actor, [], async (manager) => {
        const user = await manager.getRepository(User).save({
          username,
          email,
          displayName: username,
          passwordHash,
          role: input.role,
          status: UserStatus.ACTIVE,
          tokenVersion: 0,
          deletedAt: null,
        });
        return toAdminUserDto(user);
      });
      this.logger.log(`Admin ${actor.id} created user ${created.id}`);
      return created;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Username or email is already in use');
      throw error;
    }
  }

  async changeRole(actor: AuthenticatedActor, id: string, input: ChangeRoleDto): Promise<AdminUserDto> {
    this.rejectSelf(actor, id);
    const updated = await this.adminTransaction(actor, [id], async (manager, locked) => {
      const target = this.target(locked, id);
      this.requireMutable(target);
      if (target.role === input.role) return toAdminUserDto(target);
      if (target.role === Role.ADMIN && target.status === UserStatus.ACTIVE) {
        await this.requireRemainingAdmin(manager);
      }
      target.role = input.role;
      target.tokenVersion += 1;
      const saved = await manager.getRepository(User).save(target);
      await this.revokeFamilies(manager, id);
      return toAdminUserDto(saved);
    });
    this.logger.log(`Admin ${actor.id} changed role for user ${id}`);
    return updated;
  }

  async disable(actor: AuthenticatedActor, id: string): Promise<AdminUserDto> {
    this.rejectSelf(actor, id);
    const updated = await this.adminTransaction(actor, [id], async (manager, locked) => {
      const target = this.target(locked, id);
      if (target.status === UserStatus.DELETED) throw new ConflictException('Deleted users cannot be disabled');
      if (target.status === UserStatus.DISABLED) return toAdminUserDto(target);
      if (target.role === Role.ADMIN) await this.requireRemainingAdmin(manager);
      target.status = UserStatus.DISABLED;
      target.tokenVersion += 1;
      const saved = await manager.getRepository(User).save(target);
      await this.revokeFamilies(manager, id);
      return toAdminUserDto(saved);
    });
    this.logger.log(`Admin ${actor.id} disabled user ${id}`);
    return updated;
  }

  async enable(actor: AuthenticatedActor, id: string): Promise<AdminUserDto> {
    const updated = await this.adminTransaction(actor, [id], async (manager, locked) => {
      const target = this.target(locked, id);
      if (target.status === UserStatus.DELETED) throw new ConflictException('Deleted users cannot be enabled');
      if (target.status === UserStatus.ACTIVE) return toAdminUserDto(target);
      target.status = UserStatus.ACTIVE;
      return toAdminUserDto(await manager.getRepository(User).save(target));
    });
    this.logger.log(`Admin ${actor.id} enabled user ${id}`);
    return updated;
  }

  async remove(actor: AuthenticatedActor, id: string): Promise<void> {
    this.rejectSelf(actor, id);
    await this.adminTransaction(actor, [id], async (manager, locked) => {
      const target = this.target(locked, id);
      if (target.status === UserStatus.DELETED) return;
      if (target.role === Role.ADMIN && target.status === UserStatus.ACTIVE) {
        await this.requireRemainingAdmin(manager);
      }
      const [{ now }] = await manager.query('SELECT clock_timestamp() AS now');
      target.status = UserStatus.DELETED;
      target.deletedAt = now;
      target.tokenVersion += 1;
      await manager.getRepository(User).save(target);
      await this.revokeFamilies(manager, id);
    });
    this.logger.log(`Admin ${actor.id} soft-deleted user ${id}`);
  }

  private async adminTransaction<T>(
    actor: AuthenticatedActor,
    targetIds: string[],
    action: (manager: EntityManager, lockedUsers: Map<string, User>) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query("SET LOCAL lock_timeout = '3s'");
      await manager.query('SELECT pg_advisory_xact_lock(39582, 1)');
      const ids = [...new Set([actor.id, ...targetIds])].sort();
      const locked = new Map<string, User>();
      const repository = manager.getRepository(User);
      for (const id of ids) {
        const user = await repository.createQueryBuilder('u')
          .addSelect('u.passwordHash')
          .setLock('pessimistic_write')
          .where('u.id = :id', { id })
          .getOne();
        if (user) locked.set(id, user);
      }
      const caller = locked.get(actor.id);
      if (!caller || caller.role !== Role.ADMIN || caller.status !== UserStatus.ACTIVE
        || caller.tokenVersion !== actor.tokenVersion) {
        throw new UnauthorizedException();
      }
      const family = await manager.getRepository(RefreshFamily).findOneBy({
        id: actor.familyId,
        userId: actor.id,
        revokedAt: IsNull(),
      });
      const [{ now }] = await manager.query('SELECT clock_timestamp() AS now');
      if (!family || family.expiresAt <= now) throw new UnauthorizedException();
      return action(manager, locked);
    });
  }

  private target(users: Map<string, User>, id: string): User {
    const user = users.get(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private requireMutable(user: User): void {
    if (user.status === UserStatus.DELETED) throw new ConflictException('Deleted users cannot be edited');
  }

  private rejectSelf(actor: AuthenticatedActor, targetId: string): void {
    if (actor.id === targetId) throw new ConflictException('Admins cannot mutate their own account');
  }

  private async requireRemainingAdmin(manager: EntityManager): Promise<void> {
    const activeAdmins = await manager.getRepository(User).countBy({
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
    });
    if (activeAdmins <= 1) throw new ConflictException('At least one active admin must remain');
  }

  private async revokeFamilies(manager: EntityManager, userId: string): Promise<void> {
    const [{ now }] = await manager.query('SELECT clock_timestamp() AS now');
    await manager.getRepository(RefreshFamily).createQueryBuilder()
      .update(RefreshFamily)
      .set({ revokedAt: now })
      .where('user_id = :userId AND revoked_at IS NULL', { userId })
      .execute();
  }
}