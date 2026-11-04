import 'dotenv/config';

export const GATEWAY_CONFIG = Symbol('GATEWAY_CONFIG');

export enum Role {
  PLAYER = 'player',
  ADMIN = 'admin',
}

export interface AppConfig {
  host: string;
  port: number;
  engineInternalUrl: string;
  internalApiToken: string;
  corsOrigins: string[];
  swaggerEnabled: boolean;
  database: {
    host: string;
    port: number;
    user: string;
    password: string;
    name: string;
    ssl: boolean;
  };
  jwt: {
    secret: Buffer;
    ttlSeconds: number;
    issuer: string;
    audience: string;
    refreshTtlDays: number;
  };
}

function integer(value: string | undefined, name: string, fallback?: number): number {
  const parsed = value === undefined && fallback !== undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function boolean(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const secretText = required(env.JWT_ACCESS_SECRET, 'JWT_ACCESS_SECRET');
  if (/replace|placeholder/i.test(secretText) || !/^[A-Za-z0-9+/]+={0,2}$/.test(secretText)) {
    throw new Error('JWT_ACCESS_SECRET must be base64-encoded random bytes');
  }
  const secret = Buffer.from(secretText, 'base64');
  if (secret.length < 32 || secret.toString('base64').replace(/=+$/, '') !== secretText.replace(/=+$/, '')) {
    throw new Error('JWT_ACCESS_SECRET must decode to at least 32 bytes');
  }

  const internalApiToken = env.INTERNAL_API_TOKEN ?? '';
  if (internalApiToken) {
    const bytes = Buffer.from(internalApiToken, 'base64');
    if (bytes.length < 32 || bytes.toString('base64') !== internalApiToken) {
      throw new Error('INTERNAL_API_TOKEN must be canonical base64 encoding of at least 32 bytes');
    }
  }
  const engineUrl = new URL(env.ENGINE_INTERNAL_URL ?? 'http://127.0.0.1:3001');
  if (!['http:', 'https:'].includes(engineUrl.protocol) || engineUrl.username || engineUrl.password
    || engineUrl.search || engineUrl.hash || engineUrl.pathname !== '/') throw new Error('Invalid ENGINE_INTERNAL_URL');
  const corsOrigins = (env.CORS_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean);
  for (const origin of corsOrigins) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('CORS_ORIGINS must contain exact HTTP origins');
    }
  }

  return {
    host: env.HOST ?? '127.0.0.1',
    port: integer(env.PORT, 'PORT', 3000),
    engineInternalUrl: engineUrl.origin,
    internalApiToken,
    corsOrigins,
    swaggerEnabled: boolean(env.SWAGGER_ENABLED, 'SWAGGER_ENABLED', env.NODE_ENV !== 'production'),
    database: {
      host: required(env.DB_HOST, 'DB_HOST'),
      port: integer(env.DB_PORT, 'DB_PORT', 5432),
      user: required(env.DB_USER, 'DB_USER'),
      password: required(env.DB_PASSWORD, 'DB_PASSWORD'),
      name: required(env.DB_NAME, 'DB_NAME'),
      ssl: boolean(env.DB_SSL, 'DB_SSL', false),
    },
    jwt: {
      secret,
      ttlSeconds: integer(env.JWT_ACCESS_TTL, 'JWT_ACCESS_TTL', 900),
      issuer: env.JWT_ISSUER ?? 'escape-room-api',
      audience: env.JWT_AUDIENCE ?? 'escape-room-client',
      refreshTtlDays: integer(env.REFRESH_TOKEN_TTL_DAYS, 'REFRESH_TOKEN_TTL_DAYS', 7),
    },
  };
}

export function databaseOptions(env: NodeJS.ProcessEnv = process.env) {
  return gatewayDatabaseOptions(loadConfig(env));
}

export function gatewayDatabaseOptions(appConfig: AppConfig) {
  const config = appConfig.database;
  return {
    type: 'postgres' as const,
    host: config.host,
    port: config.port,
    username: config.user,
    password: config.password,
    database: config.name,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    synchronize: false,
    migrationsRun: false,
    extra: { connectionTimeoutMillis: 2000 },
  };
}