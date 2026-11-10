import { ROOM2_FILE } from './room2';
import { room2Scenario } from './room2-scenario.generated';

/** The reveal content for the `tls-decryptor` solve (R2-07 returns this as `reveal` on the solved evaluation). */
export function room2TlsReveal(): Record<string, string> {
  return { [ROOM2_FILE]: room2Scenario.captureDecrypted };
}
