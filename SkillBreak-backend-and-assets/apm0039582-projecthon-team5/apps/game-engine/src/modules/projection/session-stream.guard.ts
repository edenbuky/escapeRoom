import { CanActivate, ExecutionContext, Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { ENGINE_CONFIG, type EngineConfig } from '../../config/config';
import { integer, uuid } from './projection.reducer';

export interface StreamClaims { subject: string; expiresAt: number }
export interface StreamRequest extends Request { projectionAuth: StreamClaims }

@Injectable()
export class SessionStreamGuard implements CanActivate {
  private readonly logger = new Logger(SessionStreamGuard.name);
  constructor(@Inject(ENGINE_CONFIG) private readonly config: EngineConfig) {}
  verify(authorization: unknown): StreamClaims {
    const config = this.config.jwt;
    if (!config) throw new ServiceUnavailableException('projection_unavailable');
    try {
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw new Error('Missing bearer');
      const claims = jwt.verify(authorization.slice(7), config.secret, {
        algorithms: ['HS256'], issuer: config.issuer, audience: config.audience, clockTolerance: 5,
      });
      if (typeof claims === 'string') throw new Error('Invalid claims');
      const subject = uuid(claims.sub);
      uuid(claims.fid);
      integer(claims.ver);
      const issued = integer(claims.iat), expires = integer(claims.exp);
      const now = Date.now() / 1000;
      if (expires <= issued || expires - issued > config.ttlSeconds || issued > now + 5 || now >= expires) {
        throw new Error('Invalid token lifetime');
      }
      return { subject, expiresAt: expires * 1000 };
    } catch {
      this.logger.warn('Session stream authentication denied');
      throw new UnauthorizedException();
    }
  }
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<StreamRequest>();
    request.projectionAuth = this.verify(request.headers.authorization);
    return true;
  }
}
