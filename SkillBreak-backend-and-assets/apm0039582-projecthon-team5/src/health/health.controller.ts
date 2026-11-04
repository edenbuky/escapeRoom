import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { describeFailure } from '@team5/messaging';
import { DataSource } from 'typeorm';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  @SkipThrottle()
  @ApiOperation({ summary: 'Check API and database availability' })
  async check(): Promise<{ status: 'ok'; db: 'up' }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.dataSource.query('SELECT 1'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Health probe timeout')), 2000);
        }),
      ]);
      return { status: 'ok', db: 'up' };
    } catch (error) {
      this.logger.warn(`Gateway database health check failed: ${describeFailure(error)}`);
      throw new ServiceUnavailableException('Database unavailable');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}