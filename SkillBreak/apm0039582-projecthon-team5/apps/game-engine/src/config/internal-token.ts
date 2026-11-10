import { timingSafeEqual } from 'node:crypto';

export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

export function requireInternalToken(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  if (/replace|placeholder/i.test(value) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    || bytes.length < 32 || bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new Error('INTERNAL_API_TOKEN must be base64-encoded random bytes (at least 32 bytes)');
  }
  return value;
}
export function matchesInternalToken(received: unknown, expected: string): boolean {
  if (typeof received !== 'string' || !expected) return false;
  const actual = Buffer.from(received);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}