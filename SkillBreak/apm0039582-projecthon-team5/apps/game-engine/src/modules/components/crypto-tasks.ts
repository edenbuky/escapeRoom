import { constants, createDecipheriv, createHmac, createPrivateKey, privateDecrypt, timingSafeEqual } from 'node:crypto';

/** Pure task handlers executed inside the crypto worker. Add a new task kind (e.g. 'tls') with one entry in `handlers`. */
export interface RsaTask { privateKey: string; encryptedPmsHex: string; modulusHex: string;
  seed: { modulusHex: string; encryptedPmsHex: string; expectedPmsHex: string } }
export type RsaOutcome = 'solved' | 'wrong' | 'malformed' | 'tooLarge';

export const MAX_RSA_BITS = 4096;

const same = (a: Buffer, b: Buffer): boolean => {
  const length = Math.max(a.length, b.length);
  const left = Buffer.alloc(length); const right = Buffer.alloc(length);
  a.copy(left, length - a.length); b.copy(right, length - b.length);
  return timingSafeEqual(left, right) && a.length === b.length;
};

export function normalizeHex(value: string): string {
  return value.replace(/[\s:]/g, '').replace(/^0x/i, '').toLowerCase().replace(/^(00)+(?=.)/, '');
}

/** Removes PKCS#1 v1.5 type 2 padding: 00 02 <non-zero padding, >= 8 bytes> 00 <message>. */
export function unpadPkcs1(block: Buffer): Buffer | undefined {
  if (block.length < 11 || block[0] !== 0x00 || block[1] !== 0x02) return undefined;
  const end = block.indexOf(0x00, 2);
  if (end < 10) return undefined;
  return block.subarray(end + 1);
}

export function rsaTask(task: RsaTask): RsaOutcome {
  let key;
  try { key = createPrivateKey(task.privateKey); } catch { return 'malformed'; }
  if (key.asymmetricKeyType !== 'rsa') return 'malformed';
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits > MAX_RSA_BITS) return 'tooLarge';
  let keyModulus: string;
  try { keyModulus = normalizeHex(Buffer.from(key.export({ format: 'jwk' }).n as string, 'base64url').toString('hex')); }
  catch { return 'malformed'; }
  const wantedModulus = normalizeHex(task.seed.modulusHex);
  const hex = (value: string) => Buffer.from(value, 'utf8');
  let ok = same(hex(keyModulus), hex(wantedModulus));
  ok = same(hex(normalizeHex(task.modulusHex)), hex(wantedModulus)) && ok;
  ok = same(hex(normalizeHex(task.encryptedPmsHex)), hex(normalizeHex(task.seed.encryptedPmsHex))) && ok;
  let pms: Buffer = Buffer.alloc(0);
  try {
    // Node 22 refuses RSA_PKCS1_PADDING for privateDecrypt, so decrypt raw and unpad manually.
    const block = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, Buffer.from(task.seed.encryptedPmsHex, 'hex'));
    pms = unpadPkcs1(block) ?? Buffer.alloc(0);
  } catch { ok = false; }
  return same(pms, Buffer.from(task.seed.expectedPmsHex, 'hex')) && ok ? 'solved' : 'wrong';
}

export interface TlsRecord { direction: 'client' | 'server'; contentType: number; sequence: number; fragmentHex: string }
export interface TlsTask { pmsHex: string; clientRandomHex: string; seed: { serverRandomHex: string; records: TlsRecord[] } }
export type TlsOutcome = 'solved' | 'wrong';

function prf(secret: Buffer, label: string, seed: Buffer, length: number): Buffer {
  const labelSeed = Buffer.concat([Buffer.from(label), seed]);
  const parts: Buffer[] = [];
  for (let a = labelSeed, total = 0; total < length; total += 32) {
    a = createHmac('sha256', secret).update(a).digest();
    parts.push(createHmac('sha256', secret).update(a).update(labelSeed).digest());
  }
  return Buffer.concat(parts).subarray(0, length);
}

/** TLS 1.2 TLS_RSA_WITH_AES_128_GCM_SHA256: solved iff every recorded GCM tag verifies under keys derived from PMS + Client Random. */
export function tlsTask(task: TlsTask): TlsOutcome {
  const clientRandom = Buffer.from(task.clientRandomHex, 'hex');
  const serverRandom = Buffer.from(task.seed.serverRandomHex, 'hex');
  const master = prf(Buffer.from(task.pmsHex, 'hex'), 'master secret', Buffer.concat([clientRandom, serverRandom]), 48);
  const block = prf(master, 'key expansion', Buffer.concat([serverRandom, clientRandom]), 40);
  const keys = { client: { key: block.subarray(0, 16), salt: block.subarray(32, 36) }, server: { key: block.subarray(16, 32), salt: block.subarray(36, 40) } };
  let ok = task.seed.records.length > 0;
  for (const entry of task.seed.records) {
    const fragment = Buffer.from(entry.fragmentHex, 'hex');
    const { key, salt } = keys[entry.direction];
    const body = fragment.subarray(8, fragment.length - 16);
    const aad = Buffer.alloc(13);
    aad.writeBigUInt64BE(BigInt(entry.sequence), 0);
    aad.writeUInt8(entry.contentType, 8);
    aad.writeUInt16BE(0x0303, 9);
    aad.writeUInt16BE(body.length, 11);
    try {
      const decipher = createDecipheriv('aes-128-gcm', key, Buffer.concat([salt, fragment.subarray(0, 8)]));
      decipher.setAAD(aad);
      decipher.setAuthTag(fragment.subarray(fragment.length - 16));
      decipher.update(body); decipher.final();
    } catch { ok = false; }
  }
  return ok ? 'solved' : 'wrong';
}

export const handlers: Record<string, (task: any) => unknown> = {
  hash: (task: { input: string; expected: string }) => {
    const input = Buffer.from(task.input, 'hex');
    const expected = Buffer.from(task.expected, 'hex');
    return input.length === expected.length && timingSafeEqual(input, expected);
  },
  rsa: rsaTask,
  tls: tlsTask,
};
