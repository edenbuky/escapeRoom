import { DynamicModule, Module } from '@nestjs/common';
import type { MessageProducer } from '@team5/contracts/server';
import { AuthModule } from '../auth/auth.module';
import { AppConfig, GATEWAY_CONFIG } from '../config/config';
import { SessionOwnerClient } from './session-owner.client';
import { SessionsController } from './sessions.controller';
import { SESSION_PUBLISHER, SessionsService, UnavailableSessionPublisher } from './sessions.service';

@Module({})
export class SessionsModule {
  static register(producer?: MessageProducer): DynamicModule {
    return { module: SessionsModule, imports: [AuthModule], controllers: [SessionsController], providers: [
      SessionsService,
      { provide: SESSION_PUBLISHER, useValue: producer ?? new UnavailableSessionPublisher() },
      { provide: SessionOwnerClient, inject: [GATEWAY_CONFIG], useFactory: (config: AppConfig) =>
        new SessionOwnerClient(config.engineInternalUrl, config.internalApiToken) },
    ] };
  }
}