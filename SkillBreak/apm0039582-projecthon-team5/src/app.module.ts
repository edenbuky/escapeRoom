import { DynamicModule, Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import type { MessageProducer } from '@team5/contracts/server';
import { AppConfig, GATEWAY_CONFIG } from './config/config';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { UsersModule } from './users/users.module';
import { SessionsModule } from './sessions/sessions.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    AuthModule,
    UsersModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {
  static register(config: AppConfig, database: DataSource, owned: boolean, producer?: MessageProducer): DynamicModule {
    class DatabaseLifetime implements OnApplicationShutdown {
      async onApplicationShutdown(): Promise<void> {
        if (owned && database.isInitialized) await database.destroy();
      }
    }
    @Global()
    @Module({
      providers: [{ provide: DataSource, useValue: database }, { provide: GATEWAY_CONFIG, useValue: config }, DatabaseLifetime],
      exports: [DataSource, GATEWAY_CONFIG],
    })
    class GatewayDependencies {}
    return { module: AppModule, imports: [GatewayDependencies, SessionsModule.register(producer)] };
  }
}