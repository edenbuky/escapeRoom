import {
  ConflictException,
  Injectable,
  Inject,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { DataSource, EntityManager, IsNull, QueryFailedError, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { AppConfig, GATEWAY_CONFIG, Role, loadConfig } from '../config/config';
import { RefreshFamily } from '../database/entities/refresh-family.entity';
import { RefreshToken } from '../database/entities/refresh-token.entity';
import { User, UserStatus } from '../database/entities/user.entity';
import { AccessTokenDto, LoginDto, SignupDto, UserDto } from './dto/auth.dto';
import { ChangePasswordDto, RefreshCredentialDto } from './dto/auth.dto';

const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};
const DUMMY_HASH = argon2.hash('fixed-dummy-password-never-used', ARGON_OPTIONS);

export interface AuthenticatedActor {
  id: string;
  username: string;
  role: Role;
  familyId: string;
  tokenVersion: number;
}

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

function isUniqueViolation(error: unknown): boolean {
  return error instanceof QueryFailedError
    && typeof error.driverError === 'object'
    && error.driverError !== null
    && 'code' in error.driverError
    && error.driverError.code === '23505';
}

@Injectable()
export class AuthService {
  private readonly config: AppConfig;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(User) private readonly users: Repository<User>,
    @Optional() @Inject(GATEWAY_CONFIG) config?: AppConfig,
  ) { this.config = config ?? loadConfig(); }

  async signup(input: SignupDto): Promise<UserDto> {
    const username = input.username.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();
    this.validatePasswordForUsername(input.password, username);
    const passwordHash = await argon2.hash(input.password, ARGON_OPTIONS);
    try {
      const user = this.users.create({
        username,
        email,
        displayName: username,
        passwordHash,
        role: Role.PLAYER,
        status: UserStatus.ACTIVE,
      });
      return toUserDto(await this.users.save(user));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Username or email is already in use');
      throw error;
    }
  }

  async login(input: LoginDto): Promise<AccessTokenDto> {
    const user = await this.users.createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.username = :username', { username: input.username })
      .getOne();

    if (!user || user.status !== UserStatus.ACTIVE) {
      await argon2.verify(await DUMMY_HASH, input.password).catch(() => false);
      throw new UnauthorizedException('Invalid username or password');
    }
    const validPassword = await argon2.verify(user.passwordHash, input.password).catch(() => false);
    if (!validPassword) throw new UnauthorizedException('Invalid username or password');

    const token = await this.dataSource.transaction(async (manager) => {
      await manager.query("SET LOCAL lock_timeout = '3s'");
      const lockedUser = await manager.getRepository(User).createQueryBuilder('u')
        .addSelect('u.passwordHash')
        .setLock('pessimistic_write')
        .where('u.id = :id', { id: user.id })
        .getOne();
      if (!lockedUser || lockedUser.status !== UserStatus.ACTIVE
        || lockedUser.passwordHash !== user.passwordHash
        || lockedUser.tokenVersion !== user.tokenVersion) {
        throw new UnauthorizedException('Invalid username or password');
      }

      const [{ now }] = await manager.query('SELECT clock_timestamp() AS now');
      const familyExpiresAt = new Date(now.getTime() + this.config.jwt.refreshTtlDays * 86_400_000);
      const family = await manager.getRepository(RefreshFamily).save({
        userId: lockedUser.id,
        createdAt: now,
        expiresAt: familyExpiresAt,
        revokedAt: null,
      });
      const refreshToken = await this.createRefreshCredential();
      await manager.getRepository(RefreshToken).save({
        familyId: family.id,
        tokenHash: this.createTokenHash(refreshToken),
        createdAt: now,
        usedAt: null,
      });
      const expiresIn = Math.min(
        this.config.jwt.ttlSeconds,
        Math.floor((familyExpiresAt.getTime() - now.getTime()) / 1000),
      );
      const accessToken = jwt.sign(
        { fid: family.id, ver: lockedUser.tokenVersion },
        this.config.jwt.secret,
        {
          algorithm: 'HS256',
          subject: lockedUser.id,
          issuer: this.config.jwt.issuer,
          audience: this.config.jwt.audience,
          expiresIn,
        },
      );
      return {
        accessToken,
        expiresIn,
        refreshToken,
        refreshExpiresAt: familyExpiresAt.toISOString(),
        user: toUserDto(lockedUser),
      };
    });

    return { ...token, tokenType: 'Bearer' };
  }

  createTokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async createRefreshCredential(): Promise<string> {
    return randomBytes(32).toString('base64url');
  }

  async refresh(input: RefreshCredentialDto): Promise<AccessTokenDto> {
    const tokenHash = this.createTokenHash(input.refreshToken);
    const locator = await this.dataSource.createQueryBuilder()
      .select(['t.id AS id', 'f.user_id AS "userId"'])
      .from(RefreshToken, 't')
      .innerJoin(RefreshFamily, 'f', 'f.id = t.family_id')
      .where('t.token_hash = :tokenHash', { tokenHash })
      .getRawOne<{ id: string; userId: string }>();
    if (!locator) throw new UnauthorizedException();

    const outcome = await this.dataSource.transaction(async (manager) => {
      await manager.query("SET LOCAL lock_timeout = '3s'");
      const user = await manager.getRepository(User).createQueryBuilder('u')
        .setLock('pessimistic_write')
        .where('u.id = :id', { id: locator.userId })
        .getOne();
      if (!user || user.status !== UserStatus.ACTIVE) return { kind: 'invalid' as const };

      const token = await manager.getRepository(RefreshToken).findOneBy({ id: locator.id });
      const family = token
        ? await manager.getRepository(RefreshFamily).findOneBy({ id: token.familyId, userId: user.id })
        : null;
      const [{ now }] = await manager.query('SELECT clock_timestamp() AS now');
      if (!token || !family || family.revokedAt || family.expiresAt <= now) {
        return { kind: 'invalid' as const };
      }
      if (token.usedAt) {
        family.revokedAt = now;
        await manager.getRepository(RefreshFamily).save(family);
        return { kind: 'replay' as const };
      }

      const remainingSeconds = Math.floor((family.expiresAt.getTime() - now.getTime()) / 1000);
      const expiresIn = Math.min(this.config.jwt.ttlSeconds, remainingSeconds);
      if (expiresIn <= 0) return { kind: 'invalid' as const };

      token.usedAt = now;
      await manager.getRepository(RefreshToken).save(token);
      const refreshToken = await this.createRefreshCredential();
      await manager.getRepository(RefreshToken).save({
        familyId: family.id,
        tokenHash: this.createTokenHash(refreshToken),
        createdAt: now,
        usedAt: null,
      });
      const accessToken = this.signAccessToken(user, family.id, expiresIn);
      return {
        kind: 'rotated' as const,
        token: {
          accessToken,
          expiresIn,
          refreshToken,
          refreshExpiresAt: family.expiresAt.toISOString(),
          user: toUserDto(user),
        },
      };
    });

    if (outcome.kind !== 'rotated') throw new UnauthorizedException();
    return { ...outcome.token, tokenType: 'Bearer' };
  }

  async logout(input: RefreshCredentialDto): Promise<void> {
    const tokenHash = this.createTokenHash(input.refreshToken);
    const locator = await this.dataSource.createQueryBuilder()
      .select(['f.id AS "familyId"', 'f.user_id AS "userId"'])
      .from(RefreshToken, 't')
      .innerJoin(RefreshFamily, 'f', 'f.id = t.family_id')
      .where('t.token_hash = :tokenHash', { tokenHash })
      .getRawOne<{ familyId: string; userId: string }>();
    if (!locator) return;

    await this.dataSource.transaction(async (manager) => {
      await manager.query("SET LOCAL lock_timeout = '3s'");
      await manager.getRepository(User).createQueryBuilder('u')
        .setLock('pessimistic_write')
        .where('u.id = :id', { id: locator.userId })
        .getOne();
      const family = await manager.getRepository(RefreshFamily).findOneBy({
        id: locator.familyId,
        userId: locator.userId,
      });
      if (!family || family.revokedAt) return;
      const [{ now }] = await manager.query('SELECT clock_timestamp() AS now');
      family.revokedAt = now;
      await manager.getRepository(RefreshFamily).save(family);
    });
  }

  async logoutAll(actor: AuthenticatedActor): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const { user, now } = await this.lockCurrentActor(manager, actor);
      user.tokenVersion += 1;
      await manager.getRepository(User).save(user);
      await this.revokeUserFamilies(manager, user.id, now);
    });
  }

  async changePassword(actor: AuthenticatedActor, input: ChangePasswordDto): Promise<void> {
    const snapshot = await this.users.createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.id = :id', { id: actor.id })
      .getOne();
    if (!snapshot || snapshot.status !== UserStatus.ACTIVE
      || !(await argon2.verify(snapshot.passwordHash, input.currentPassword).catch(() => false))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    this.validatePasswordForUsername(input.newPassword, snapshot.username);
    const passwordHash = await argon2.hash(input.newPassword, ARGON_OPTIONS);

    await this.dataSource.transaction(async (manager) => {
      const { user, now } = await this.lockCurrentActor(manager, actor);
      if (user.passwordHash !== snapshot.passwordHash) throw new UnauthorizedException();
      user.passwordHash = passwordHash;
      user.tokenVersion += 1;
      await manager.getRepository(User).save(user);
      await this.revokeUserFamilies(manager, user.id, now);
    });
  }

  get jwtConfig(): AppConfig['jwt'] {
    return this.config.jwt;
  }

  private validatePasswordForUsername(password: string, username: string): void {
    if (password.toLowerCase() === username) {
      throw new ConflictException('Password must not equal username');
    }
  }

  private signAccessToken(user: User, familyId: string, expiresIn: number): string {
    return jwt.sign({ fid: familyId, ver: user.tokenVersion }, this.config.jwt.secret, {
      algorithm: 'HS256',
      subject: user.id,
      issuer: this.config.jwt.issuer,
      audience: this.config.jwt.audience,
      expiresIn,
    });
  }

  async lockCurrentActor(
    manager: EntityManager,
    actor: AuthenticatedActor,
  ): Promise<{ user: User; now: Date }> {
    await manager.query("SET LOCAL lock_timeout = '3s'");
    const user = await manager.getRepository(User).createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .setLock('pessimistic_write')
      .where('u.id = :id AND u.status = :status AND u.token_version = :version', {
        id: actor.id,
        status: UserStatus.ACTIVE,
        version: actor.tokenVersion,
      })
      .getOne();
    if (!user) throw new UnauthorizedException();
    const family = await manager.getRepository(RefreshFamily).findOneBy({
      id: actor.familyId,
      userId: actor.id,
      revokedAt: IsNull(),
    });
    const [{ now }] = await manager.query('SELECT clock_timestamp() AS now');
    if (!family || family.expiresAt <= now) throw new UnauthorizedException();
    return { user, now };
  }

  private async revokeUserFamilies(
    manager: EntityManager,
    userId: string,
    now: Date,
  ): Promise<void> {
    await manager.getRepository(RefreshFamily).createQueryBuilder()
      .update(RefreshFamily)
      .set({ revokedAt: now })
      .where('user_id = :userId AND revoked_at IS NULL', { userId })
      .execute();
  }
}