import type { Evaluation } from '../sessions/core/state';
import type { CryptoPool } from './hash-pool';
import type { TlsTask } from './crypto-tasks';
import { room2TlsReveal } from '../script-catalog/room2-reveal';

const blocked: Evaluation = { verdict: 'rejected', reason: 'policyBlocked', output: '' };
const unavailable: Evaluation = { verdict: 'rejected', reason: 'sandboxRestarting', output: '' };
const MAX_CHARS = 512;

export type TlsSeed = TlsTask['seed'];

/** Evaluates `{ kind: 'tls', pms, clientRandom }` on the crypto worker pool; the capture only leaves the server as `reveal`. */
export class TlsComponent {
  constructor(private readonly pool: Partial<Pick<CryptoPool, 'tls'>> | undefined, private readonly onFailure: (error: unknown) => void) {}

  async evaluate(seed: TlsSeed, fields: Record<string, unknown>): Promise<Evaluation> {
    if (Object.keys(fields).length !== 3 || fields.kind !== 'tls' || typeof fields.pms !== 'string' || typeof fields.clientRandom !== 'string') return blocked;
    if (fields.pms.length > MAX_CHARS || fields.clientRandom.length > MAX_CHARS) return blocked;
    const compact = (value: string) => value.replace(/[\s:]/g, '').replace(/^0x/i, '').toLowerCase();
    const pmsHex = compact(fields.pms); const randomHex = compact(fields.clientRandom);
    if (!/^[0-9a-f]{96}$/.test(pmsHex) || !/^[0-9a-f]{64}$/.test(randomHex)) return blocked;
    if (!this.pool?.tls) return unavailable;
    try {
      const outcome = await this.pool.tls({ pmsHex, clientRandomHex: randomHex, seed });
      return outcome === 'solved'
        ? { verdict: 'solved', reason: null, output: 'The file has been decrypted', reveal: room2TlsReveal() }
        : { verdict: 'rejected', reason: 'wrongAnswer', output: '' };
    } catch (error) {
      this.onFailure(error);
      return unavailable;
    }
  }
}
