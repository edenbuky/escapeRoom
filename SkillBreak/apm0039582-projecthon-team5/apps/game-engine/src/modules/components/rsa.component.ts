import type { Evaluation } from '../sessions/core/state';
import type { CryptoPool } from './hash-pool';
import { normalizeHex, type RsaTask } from './crypto-tasks';

const blocked: Evaluation = { verdict: 'rejected', reason: 'policyBlocked', output: '' };
const unavailable: Evaluation = { verdict: 'rejected', reason: 'sandboxRestarting', output: '' };
const MAX_HEX_CHARS = 8192;
const MAX_KEY_CHARS = 8192;

export type RsaSeed = RsaTask['seed'];

/** Evaluates `{ kind: 'rsa', privateKey, encryptedPms, modulus }` on the crypto worker pool. */
export class RsaComponent {
  constructor(private readonly pool: Partial<Pick<CryptoPool, 'rsa'>> | undefined, private readonly onFailure: (error: unknown) => void) {}

  async evaluate(seed: RsaSeed, fields: Record<string, unknown>): Promise<Evaluation> {
    if (Object.keys(fields).length !== 4 || fields.kind !== 'rsa' || typeof fields.privateKey !== 'string'
      || typeof fields.encryptedPms !== 'string' || typeof fields.modulus !== 'string') return blocked;
    const { privateKey, encryptedPms, modulus } = fields as { privateKey: string; encryptedPms: string; modulus: string };
    if (!privateKey.trim() || privateKey.length > MAX_KEY_CHARS || encryptedPms.length > MAX_HEX_CHARS || modulus.length > MAX_HEX_CHARS) return blocked;
    const pms = normalizeHex(encryptedPms);
    const n = normalizeHex(modulus);
    if (!/^[0-9a-f]+$/.test(pms) || pms.length % 2 || !/^[0-9a-f]+$/.test(n)) return blocked;
    if (!this.pool?.rsa) return unavailable;
    try {
      const outcome = await this.pool.rsa({ privateKey: privateKey.replace(/\r\n?/g, '\n').trim(), encryptedPmsHex: pms, modulusHex: n, seed });
      if (outcome === 'malformed' || outcome === 'tooLarge') return blocked;
      return outcome === 'solved' ? { verdict: 'solved', reason: null, output: seed.expectedPmsHex }
        : { verdict: 'rejected', reason: 'wrongAnswer', output: '' };
    } catch (error) {
      this.onFailure(error);
      return unavailable;
    }
  }
}
