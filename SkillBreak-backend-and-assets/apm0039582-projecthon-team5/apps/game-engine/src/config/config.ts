import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as dotenv } from 'dotenv';
import type { DataSourceOptions } from 'typeorm';
import { FoundationSchemas1793570400000 } from '../database/migrations/1793570400000-FoundationSchemas';
import { CatalogSchema1793570401000 } from '../database/migrations/1793570401000-CatalogSchema';
import { requireInternalToken } from './internal-token';
import { ConsumerAttempt, DeadLetter, InboxReceipt, OutboxMessage } from '@team5/messaging';
import { EngineSchema1793570402000 } from '../database/migrations/1793570402000-EngineSchema';
import { SqlSandbox1793570403000 } from '../database/migrations/1793570403000-SqlSandbox';
import { SessionProjection1793570404000 } from '../database/migrations/1793570404000-SessionProjection';

export const ENGINE_CONFIG = Symbol('ENGINE_CONFIG');
export interface EngineConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  runtimeClass: string;
  sandbox: {
    enabled: boolean;
    kubeContext?: string;
    imageAllowlist: string[];
    workerConcurrency: number;
  };
  internalApiToken?: string;
  jwt?: { secret: Buffer; issuer: string; audience: string; ttlSeconds: number };
  corsOrigins: string[];
}
function required(value: string | undefined, name: string): string {
  if (!value?.trim() || /REPLACE_|placeholder/i.test(value)) throw new Error(`${name} is required and must not be a placeholder`);
  return value;
}
function port(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return parsed;
}
function url(value: string | undefined, name: string, protocols: string[]): string {
  const text = required(value, name);
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error(`${name} must be a valid URL`); }
  if (!protocols.includes(parsed.protocol) || !parsed.hostname || parsed.hash) throw new Error(`${name} has an invalid protocol, host or fragment`);
  if (name === 'DATABASE_URL' && (!parsed.username || !parsed.password || parsed.pathname.length < 2)) {
    throw new Error('DATABASE_URL must include user, password and database');
  }
  return parsed.toString();
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  let jwt: EngineConfig['jwt'];
  if (['JWT_ACCESS_SECRET', 'JWT_ISSUER', 'JWT_AUDIENCE', 'JWT_ACCESS_TTL'].some(key => env[key] !== undefined)) {
    const text = required(env.JWT_ACCESS_SECRET, 'JWT_ACCESS_SECRET');
    const secret = Buffer.from(text, 'base64');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || secret.length < 32
      || secret.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) {
      throw new Error('JWT_ACCESS_SECRET must be base64 encoding of at least 32 bytes');
    }
    const ttlSeconds = Number(env.JWT_ACCESS_TTL ?? '900');
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error('JWT_ACCESS_TTL must be a positive integer');
    jwt = { secret, issuer: required(env.JWT_ISSUER ?? 'escape-room-api', 'JWT_ISSUER'),
      audience: required(env.JWT_AUDIENCE ?? 'escape-room-client', 'JWT_AUDIENCE'), ttlSeconds };
  }
  const corsOrigins = (env.CORS_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of corsOrigins) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error('CORS_ORIGINS must contain exact HTTP origins'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('CORS_ORIGINS must contain exact HTTP origins');
    }
  }
  let databaseUrl = env.DATABASE_URL;
  if (env.ENGINE_DB_HOST !== undefined) {
    const host = required(env.ENGINE_DB_HOST, 'ENGINE_DB_HOST');
    if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('ENGINE_DB_HOST must be a hostname');
    const name = required(env.ENGINE_DB_NAME, 'ENGINE_DB_NAME');
    if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('ENGINE_DB_NAME must contain letters, digits or underscores');
    const user = encodeURIComponent(required(env.ENGINE_DB_USER, 'ENGINE_DB_USER'));
    const password = encodeURIComponent(required(env.ENGINE_DB_PASSWORD, 'ENGINE_DB_PASSWORD'));
    databaseUrl = `postgresql://${user}:${password}@${host}:${port(env.ENGINE_DB_PORT ?? '5432', 'ENGINE_DB_PORT')}/${name}`;
  }
  const runtimeClass = env.SANDBOX_RUNTIME_CLASS ?? (env.NODE_ENV === 'production' ? 'kata' : 'runc');
  if (runtimeClass.length > 253 || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(runtimeClass)) {
    throw new Error('SANDBOX_RUNTIME_CLASS must be a valid RuntimeClass name');
  }
  const enabled = env.SANDBOX_ENABLED ?? 'false';
  if (enabled !== 'true' && enabled !== 'false') throw new Error('SANDBOX_ENABLED must be true or false');
  const kubeContext = env.SANDBOX_KUBE_CONTEXT;
  if (enabled === 'true' && env.NODE_ENV !== 'production' && kubeContext !== 'kind-skillbreak-local') {
    throw new Error('SANDBOX_KUBE_CONTEXT must explicitly be kind-skillbreak-local for local sandbox use');
  }
  const imageAllowlist = env.SANDBOX_IMAGE_ALLOWLIST?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  if ((enabled === 'true' && !imageAllowlist.length) || imageAllowlist.some(
    value => !/^[a-z0-9][a-z0-9.:-]*\/[a-z0-9][a-z0-9._/-]*$/.test(value) || value.includes('..'))) {
    throw new Error('SANDBOX_IMAGE_ALLOWLIST must contain explicit registry/repository names without tags or wildcards');
  }
  const workerConcurrency = Number(env.SANDBOX_WORKER_CONCURRENCY ?? '2');
  if (!Number.isInteger(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 4) {
    throw new Error('SANDBOX_WORKER_CONCURRENCY must be an integer from 1 to 4');
  }
  return {
    jwt, corsOrigins,
    host: env.HOST ?? '127.0.0.1',
    port: port(env.PORT ?? '3001', 'PORT'),
    databaseUrl: url(databaseUrl, 'DATABASE_URL', ['postgres:', 'postgresql:']),
    redisUrl: url(env.REDIS_URL, 'REDIS_URL', ['redis:', 'rediss:']),
    runtimeClass,
    sandbox: { enabled: enabled === 'true', kubeContext, imageAllowlist, workerConcurrency },
    internalApiToken: env.INTERNAL_API_TOKEN ? requireInternalToken(env.INTERNAL_API_TOKEN) : undefined,
  };
}
export function loadEngineConfig(): EngineConfig {
  const path = resolve(__dirname, '../../.env');
  if (existsSync(path)) {
    const result = dotenv({ path });
    if (result.error) throw new Error('Unable to read game-engine .env configuration');
  }
  return loadConfig();
}
export function databaseOptions(config: EngineConfig): DataSourceOptions {
  return {
    type: 'postgres', url: config.databaseUrl, synchronize: false, migrationsRun: false,
    migrations: [FoundationSchemas1793570400000, CatalogSchema1793570401000, EngineSchema1793570402000, SqlSandbox1793570403000,
      SessionProjection1793570404000],
    entities: [ConsumerAttempt, DeadLetter, InboxReceipt, OutboxMessage],
    extra: { max: 10, connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 2000 },
  };
}
