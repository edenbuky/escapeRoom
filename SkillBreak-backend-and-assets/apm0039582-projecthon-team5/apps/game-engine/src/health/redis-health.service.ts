import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { describeFailure } from '@team5/messaging';
import Redis from 'ioredis';
import { ENGINE_CONFIG, type EngineConfig } from '../config/config';

@Injectable()
export class RedisHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly client: Redis;
  private readonly logger = new Logger(RedisHealthService.name);

  constructor(@Inject(ENGINE_CONFIG) config: EngineConfig) {
    this.client = new Redis(config.redisUrl, {
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
      connectTimeout: 2000, commandTimeout: 2000, retryStrategy: () => 2000,
    });
    this.client.on('error', () => this.logger.warn('Redis connection unavailable'));
  }
  onModuleInit(): void {
    void this.client.connect().catch(error => this.logger.warn(`Initial Redis connection failed; reconnecting: ${describeFailure(error)}`));
  }
  async ping(): Promise<void> {
    if (this.client.status !== 'ready') throw new Error('Redis unavailable');
    if (await this.client.ping() !== 'PONG') throw new Error('Redis health response invalid');
  }
  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
