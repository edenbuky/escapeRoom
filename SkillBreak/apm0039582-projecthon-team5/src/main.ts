import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { json, urlencoded, Request, Response, NextFunction } from 'express';
import { DataSource } from 'typeorm';
import type { MessageProducer } from '@team5/contracts/server';
import { AppModule } from './app.module';
import { AppConfig, gatewayDatabaseOptions, loadConfig } from './config/config';
import { DatabaseExceptionFilter } from './database/database-exception.filter';
import { RefreshFamily } from './database/entities/refresh-family.entity';
import { RefreshToken } from './database/entities/refresh-token.entity';
import { User } from './database/entities/user.entity';

export interface GatewayAppOptions {
  config?: AppConfig;
  database?: DataSource;
  producer?: MessageProducer;
}

export async function createGatewayApp(options: GatewayAppOptions = {}): Promise<INestApplication> {
  const config = options.config ?? loadConfig();
  const database = options.database ?? new DataSource({ ...gatewayDatabaseOptions(config), entities: [User, RefreshFamily, RefreshToken] });
  const owned = !options.database;
  let app: INestApplication | undefined;
  try {
    if (owned) await database.initialize();
    else if (!database.isInitialized) throw new Error('Injected gateway database must be initialized');
    app = await NestFactory.create(AppModule.register(config, database, owned, options.producer), {
      bodyParser: false, abortOnError: false,
    });
    configureHttp(app, config);
    await app.init();
    return app;
  } catch (error) {
    try { if (app) await app.close(); }
    finally { if (owned && database.isInitialized) await database.destroy(); }
    throw error;
  }
}

function configureHttp(app: INestApplication, config: AppConfig): void {
  app.use(helmet());
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store'); next();
  });
  if (config.corsOrigins.length) app.enableCors({ origin: config.corsOrigins, credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Skillbreak-Browser'], exposedHeaders: ['Date'] });
  app.use(json({ limit: '16kb' }));
  app.use(urlencoded({ extended: false, limit: '16kb' }));
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }));
  app.useGlobalFilters(new DatabaseExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Projecthon API')
    .setDescription('Escape-room authentication and session commands')
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    .build();
  if (config.swaggerEnabled) SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig), {
    swaggerOptions: { persistAuthorization: false },
  });

}

export async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createGatewayApp({ config });
  app.enableShutdownHooks();
  try { await app.listen(config.port, config.host); }
  catch (error) { await app.close(); throw error; }
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    process.stderr.write(`API startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}