import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describeFailure } from '@team5/messaging';
import * as jwt from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import { Role } from '../config/config';
import { AuthService } from './auth.service';
import { ROLES_KEY } from './roles.decorator';

interface AccessClaims extends jwt.JwtPayload {
  fid: string;
  ver: number;
  sub: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }

    let claims: AccessClaims;
    try {
      const decoded = jwt.verify(authorization.slice(7), this.auth.jwtConfig.secret, {
        algorithms: ['HS256'],
        issuer: this.auth.jwtConfig.issuer,
        audience: this.auth.jwtConfig.audience,
        clockTolerance: 5,
      });
      if (typeof decoded === 'string') throw new Error('Invalid claims');
      claims = decoded as AccessClaims;
      const now = Math.floor(Date.now() / 1000);
      const issuedAt = claims.iat;
      const expiresAt = claims.exp;
      if (!UUID_PATTERN.test(claims.sub) || !UUID_PATTERN.test(claims.fid)
        || !Number.isSafeInteger(claims.ver) || claims.ver < 0
        || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
        || typeof issuedAt !== 'number' || typeof expiresAt !== 'number'
        || expiresAt <= issuedAt || issuedAt > now + 5
        || expiresAt - issuedAt > this.auth.jwtConfig.ttlSeconds) {
        throw new Error('Invalid claims');
      }
    } catch {
      throw new UnauthorizedException();
    }

    try {
      const account = await this.dataSource.createQueryBuilder()
        .select(['u.id AS id', 'u.username AS username', 'u.role AS role'])
        .from('users', 'u')
        .innerJoin(
          'refresh_families',
          'f',
          'f.id = :familyId AND f.user_id = u.id AND f.revoked_at IS NULL AND f.expires_at > now()',
          { familyId: claims.fid },
        )
        .where('u.id = :userId AND u.status = :status AND u.token_version = :version', {
          userId: claims.sub,
          status: 'active',
          version: claims.ver,
        })
        .getRawOne<{ id: string; username: string; role: Role }>();
      if (!account) throw new UnauthorizedException();
      request.user = {
        ...account,
        familyId: claims.fid,
        tokenVersion: claims.ver,
      };
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.logger.warn(`Account lookup failed: ${describeFailure(error)}`);
      throw new ServiceUnavailableException('Authentication service unavailable');
    }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return false;
    const user = context.switchToHttp().getRequest().user as { role?: Role } | undefined;
    return Boolean(user?.role && roles.includes(user.role));
  }
}