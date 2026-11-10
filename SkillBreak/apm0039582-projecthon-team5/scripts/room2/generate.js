'use strict';
// Room 2 scenario generator (R2-01). Offline and deterministic: the only external input is the committed
// synthetic RSA key (scripts/room2/rsa-private-key.pem, created once with crypto.generateKeyPairSync and
// kept in the repository so every run is identical). Everything else (randoms, PMS, padding, card number,
// certificate, git objects, TLS records) is derived from fixed labels. All values are fictional puzzle content.
//
//   node scripts/room2/generate.js          write the generated artifacts
//   node scripts/room2/generate.js --check  fail when the committed artifacts differ from a fresh generation
const { createHash, createHmac, createCipheriv, createPrivateKey, createPublicKey, sign } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const keyPath = path.join(__dirname, 'rsa-private-key.pem');
const gitFixturePath = path.join(root, 'sandboxes/git/fixtures/room2-git-v1.json');
const scenarioPath = path.join(root, 'apps/game-engine/src/modules/script-catalog/room2-scenario.generated.ts');

const SECURITY_FIX_MESSAGE = 'Security fix: Removed private key from repository.';
const CIPHER_SUITE = { name: 'TLS_RSA_WITH_AES_128_GCM_SHA256', id: 0x009c };
const HOST = 'pay.cibus-demo.example';
const SUBJECT = { CN: HOST, O: 'Cibus Demo' };

const sha256 = data => createHash('sha256').update(data).digest();
const hex = buffer => Buffer.from(buffer).toString('hex');
const u8 = value => Buffer.from([value]);
const u16 = value => Buffer.from([value >> 8, value & 255]);
const u24 = value => Buffer.from([value >> 16, (value >> 8) & 255, value & 255]);
const u64 = value => { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); return out; };

/** Deterministic bytes from a label (SHA-256 in counter mode). Not a general-purpose RNG. */
function derive(label, length) {
  const blocks = [];
  for (let counter = 0; blocks.length * 32 < length; counter++) blocks.push(sha256(`room2:${label}:${counter}`));
  return Buffer.concat(blocks).subarray(0, length);
}

// ---------------------------------------------------------------- DER (self-signed certificate)
const derLength = length => length < 128 ? Buffer.from([length])
  : length < 256 ? Buffer.from([0x81, length]) : Buffer.from([0x82, length >> 8, length & 255]);
const der = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]); };
const seq = (...parts) => der(0x30, ...parts);
const set = (...parts) => der(0x31, ...parts);
const derInteger = value => { const text = value.toString(16); const raw = Buffer.from(text.length % 2 ? `0${text}` : text, 'hex');
  return der(0x02, raw[0] & 0x80 ? Buffer.concat([Buffer.from([0]), raw]) : raw); };
function derOid(oid) {
  const arcs = oid.split('.').map(Number);
  const bytes = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 127];
    for (let rest = arc >> 7; rest > 0; rest >>= 7) chunk.unshift((rest & 127) | 128);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}
const rsaSha256 = () => seq(derOid('1.2.840.113549.1.1.11'), der(0x05));
const name = () => seq(...[['2.5.4.10', SUBJECT.O], ['2.5.4.3', SUBJECT.CN]]
  .map(([oid, value]) => set(seq(derOid(oid), der(0x0c, Buffer.from(value))))));
const utcTime = text => der(0x17, Buffer.from(text));
const wrapPem = (label, buffer) => `-----BEGIN ${label}-----\n${buffer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

function certificate(privateKey, publicKey) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const tbs = seq(der(0xa0, derInteger(2)), derInteger(0x0c1b50201), rsaSha256(), name(),
    seq(utcTime('260101000000Z'), utcTime('360101000000Z')), name(), spki);
  const signature = sign('sha256', tbs, privateKey);
  return seq(tbs, rsaSha256(), der(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

// ---------------------------------------------------------------- TLS 1.2 (RSA key exchange, AES-128-GCM)
function prf(secret, label, seed, length) {
  const labelSeed = Buffer.concat([Buffer.from(label), seed]);
  const out = [];
  let a = labelSeed;
  for (let total = 0; total < length; total += 32) {
    a = createHmac('sha256', secret).update(a).digest();
    out.push(createHmac('sha256', secret).update(a).update(labelSeed).digest());
  }
  return Buffer.concat(out).subarray(0, length);
}

const handshake = (type, body) => Buffer.concat([u8(type), u24(body.length), body]);
const record = (type, fragment) => Buffer.concat([u8(type), u16(0x0303), u16(fragment.length), fragment]);

/** TLS 1.2 AEAD record: explicit nonce (the sequence number) + ciphertext + 16-byte tag. */
function sealRecord(contentType, sequence, key, salt, plaintext) {
  const explicitNonce = u64(sequence);
  const cipher = createCipheriv('aes-128-gcm', key, Buffer.concat([salt, explicitNonce]));
  cipher.setAAD(Buffer.concat([u64(sequence), u8(contentType), u16(0x0303), u16(plaintext.length)]));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([explicitNonce, ciphertext, cipher.getAuthTag()]);
}

function luhnCard() {
  const digits = [4, 0, 0, 0, 0, 0, ...Array.from(derive('card', 9), byte => byte % 10)];
  const sum = [...digits].reverse().reduce((total, digit, index) => {
    const value = index % 2 === 0 ? digit * 2 : digit;
    return total + (value > 9 ? value - 9 : value);
  }, 0);
  return [...digits, (10 - (sum % 10)) % 10].join('');
}

function buildTls(privateKey, publicKey, certDer) {
  const jwk = privateKey.export({ format: 'jwk' });
  const modulus = BigInt(`0x${Buffer.from(jwk.n, 'base64url').toString('hex')}`);
  const exponent = BigInt(`0x${Buffer.from(jwk.e, 'base64url').toString('hex')}`);
  const size = Math.ceil(modulus.toString(2).length / 8);

  const clientRandom = derive('client-random', 32);
  const serverRandom = derive('server-random', 32);
  const pms = Buffer.concat([u16(0x0303), derive('pms', 46)]);

  // PKCS#1 v1.5 (type 2) padding with fixed non-zero padding bytes, then raw RSA with the public key.
  const padding = Buffer.from(derive('pkcs1-padding', size - 3 - pms.length), byte => byte === 0 ? 0xa5 : byte);
  const message = BigInt(`0x${Buffer.concat([Buffer.from([0, 2]), padding, Buffer.from([0]), pms]).toString('hex')}`);
  let encrypted = 1n;
  for (let base = message % modulus, power = exponent; power > 0n; power >>= 1n, base = (base * base) % modulus) {
    if (power & 1n) encrypted = (encrypted * base) % modulus;
  }
  const encryptedPms = Buffer.from(encrypted.toString(16).padStart(size * 2, '0'), 'hex');

  const clientHello = handshake(1, Buffer.concat([u16(0x0303), clientRandom, u8(0), u16(2), u16(CIPHER_SUITE.id), u8(1), u8(0)]));
  const serverHello = handshake(2, Buffer.concat([u16(0x0303), serverRandom, u8(0), u16(CIPHER_SUITE.id), u8(0)]));
  const certificateMessage = handshake(11, Buffer.concat([u24(certDer.length + 3), u24(certDer.length), certDer]));
  const serverHelloDone = handshake(14, Buffer.alloc(0));
  const clientKeyExchange = handshake(16, Buffer.concat([u16(encryptedPms.length), encryptedPms]));

  const masterSecret = prf(pms, 'master secret', Buffer.concat([clientRandom, serverRandom]), 48);
  const keyBlock = prf(masterSecret, 'key expansion', Buffer.concat([serverRandom, clientRandom]), 40);
  const keys = { clientKey: keyBlock.subarray(0, 16), serverKey: keyBlock.subarray(16, 32),
    clientSalt: keyBlock.subarray(32, 36), serverSalt: keyBlock.subarray(36, 40) };

  const transcript = Buffer.concat([clientHello, serverHello, certificateMessage, serverHelloDone, clientKeyExchange]);
  const clientFinished = handshake(20, prf(masterSecret, 'client finished', sha256(transcript), 12));
  const serverFinished = handshake(20, prf(masterSecret, 'server finished',
    sha256(Buffer.concat([transcript, clientFinished])), 12));

  const cardNumber = luhnCard();
  const httpBody = JSON.stringify({ merchant: 'Cibus', order: 'CIB-20261105-0417', payer: 'Nathaniel Cohen',
    card_number: cardNumber, expiry: '11/29', cvv: String(100 + (derive('cvv', 1)[0] % 900)), amount: '48.50', currency: 'ILS' });
  const request = `POST /api/v2/payments HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/json\r\n`
    + `Content-Length: ${Buffer.byteLength(httpBody)}\r\n\r\n${httpBody}`;
  const responseBody = JSON.stringify({ status: 'approved', authorization: 'A-730418', receipt: 'CIB-20261105-0417' });
  const response = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(responseBody)}\r\n\r\n${responseBody}`;

  // Finished is the first encrypted record of each direction (sequence 0); Application Data follows (sequence 1).
  const records = [
    { direction: 'client', contentType: 22, sequence: 0, plaintext: clientFinished, key: keys.clientKey, salt: keys.clientSalt },
    { direction: 'server', contentType: 22, sequence: 0, plaintext: serverFinished, key: keys.serverKey, salt: keys.serverSalt },
    { direction: 'client', contentType: 23, sequence: 1, plaintext: Buffer.from(request), key: keys.clientKey, salt: keys.clientSalt },
    { direction: 'server', contentType: 23, sequence: 1, plaintext: Buffer.from(response), key: keys.serverKey, salt: keys.serverSalt },
  ].map(entry => ({ ...entry, fragment: sealRecord(entry.contentType, entry.sequence, entry.key, entry.salt, entry.plaintext) }));

  return { clientRandom, serverRandom, pms, encryptedPms, modulusHex: modulus.toString(16), exponent: Number(exponent),
    messages: { clientHello, serverHello, certificateMessage, serverHelloDone, clientKeyExchange }, records, cardNumber };
}

// ---------------------------------------------------------------- capture renderings
function renderCapture(tls, decrypted) {
  const { messages, records } = tls;
  const lines = [];
  const frame = (direction, title) => { lines.push('', `Frame ${lines.filter(line => line.startsWith('Frame ')).length + 1} | ${direction} | ${title}`); };
  lines.push('Cibus_payment_try.pcap', `Capture: 10.20.0.14:51944 (client) <-> 10.20.0.80:443 (${HOST})`);
  frame('Client -> Server', 'TLSv1.2 Record Layer: Handshake Protocol: Client Hello');
  lines.push('  Handshake Type: Client Hello (1)', '  Version: TLS 1.2 (0x0303)', `  Client Random: ${hex(tls.clientRandom)}`,
    '  Session ID Length: 0', `  Cipher Suites (1): ${CIPHER_SUITE.name} (0x${CIPHER_SUITE.id.toString(16).padStart(4, '0')})`,
    '  Compression Methods (1): null (0)');
  frame('Server -> Client', 'TLSv1.2 Record Layer: Handshake Protocol: Server Hello');
  lines.push('  Handshake Type: Server Hello (2)', '  Version: TLS 1.2 (0x0303)', `  Server Random: ${hex(tls.serverRandom)}`,
    '  Session ID Length: 0', `  Cipher Suite: ${CIPHER_SUITE.name} (0x${CIPHER_SUITE.id.toString(16).padStart(4, '0')})`,
    '  Compression Method: null (0)');
  frame('Server -> Client', 'TLSv1.2 Record Layer: Handshake Protocol: Certificate');
  lines.push('  Handshake Type: Certificate (11)', `  Certificate (${messages.certificateMessage.length - 10} bytes)`,
    `    Subject: CN=${SUBJECT.CN}, O=${SUBJECT.O}`, `    Issuer: CN=${SUBJECT.CN}, O=${SUBJECT.O} (self-signed)`,
    '    Validity: 2026-01-01 to 2036-01-01', '    Signature Algorithm: sha256WithRSAEncryption',
    `    Public Key Algorithm: rsaEncryption (${tls.modulusHex.length * 4} bits)`, `    Public Exponent (e): ${tls.exponent}`,
    `    Modulus (N): ${tls.modulusHex}`);
  frame('Server -> Client', 'TLSv1.2 Record Layer: Handshake Protocol: Server Hello Done');
  lines.push('  Handshake Type: Server Hello Done (14)');
  frame('Client -> Server', 'TLSv1.2 Record Layer: Handshake Protocol: Client Key Exchange');
  lines.push('  Handshake Type: Client Key Exchange (16)',
    `  RSA Encrypted PreMaster Secret (${tls.encryptedPms.length} bytes): ${hex(tls.encryptedPms)}`);
  frame('Client -> Server', 'TLSv1.2 Record Layer: Change Cipher Spec');
  lines.push('  Change Cipher Spec Message (1)');
  const encryptedFrame = (entry, label) => {
    frame(entry.direction === 'client' ? 'Client -> Server' : 'Server -> Client', `TLSv1.2 Record Layer: ${label}`);
    lines.push(`  Encrypted ${entry.contentType === 22 ? 'Handshake Message' : 'Application Data'} (${entry.fragment.length} bytes): ${hex(entry.fragment)}`);
    if (!decrypted) return;
    if (entry.contentType === 22) lines.push(`  Decrypted Handshake Message: Finished (verify_data ${hex(entry.plaintext.subarray(4))})`);
    else lines.push(`  Decrypted Application Data (${entry.plaintext.length} bytes):`,
      ...entry.plaintext.toString().split('\r\n').map(line => line && `    ${line}`));
  };
  encryptedFrame(records[0], 'Handshake Protocol: Encrypted Handshake Message');
  frame('Server -> Client', 'TLSv1.2 Record Layer: Change Cipher Spec');
  lines.push('  Change Cipher Spec Message (1)');
  encryptedFrame(records[1], 'Handshake Protocol: Encrypted Handshake Message');
  encryptedFrame(records[2], 'Application Data');
  encryptedFrame(records[3], 'Application Data');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- git fixture (objects hashed like git/isomorphic-git)
const gitHash = (type, body) => createHash('sha1').update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body])).digest();

function treeOid(files) {
  const entries = Object.keys(files).sort().map(file => {
    if (file.includes('/')) throw new Error('The Room 2 git fixture keeps its files in the repository root');
    return Buffer.concat([Buffer.from(`100644 ${file}\0`), gitHash('blob', Buffer.from(files[file]))]);
  });
  return hex(gitHash('tree', Buffer.concat(entries)));
}

/** timezoneOffset follows isomorphic-git (minutes, positive west of UTC): -180 is +03:00. */
function signature(person) {
  const minutes = -person.timezoneOffset;
  const zone = `${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
  return `${person.name} <${person.email}> ${person.timestamp} ${zone}`;
}

function buildGit(privateKeyPem) {
  const nathaniel = (timestamp, timezoneOffset) => ({ name: 'Nathaniel Cohen', email: 'nathaniel@cibus-demo.example', timestamp, timezoneOffset });
  const readme = [
    '# Cibus payments client', '', 'Small client the team uses to try Cibus payment calls.', ''];
  const client = [
    "'use strict';", '// Sends a test payment to the Cibus sandbox endpoint over TLS.', "const https = require('node:https');", '',
    'function pay(order, card) {', `  return https.request({ host: '${HOST}', path: '/api/v2/payments', method: 'POST' });`, '}', '',
    'module.exports = { pay };', ''];
  const documented = [...readme, '## Local TLS test', '', 'Use server.key with the sandbox certificate to inspect test captures.', ''];
  const plan = [
    { message: 'Initial commit', when: [1789371000, -180], files: { 'README.md': readme.join('\n') } },
    { message: 'Add Cibus payment client', when: [1789458600, -180],
      files: { 'README.md': readme.join('\n'), 'payments.js': client.join('\n') } },
    { message: 'Add server key for local TLS tests', when: [1790063400, -180],
      files: { 'README.md': readme.join('\n'), 'payments.js': client.join('\n'), 'server.key': privateKeyPem } },
    { message: 'Document local TLS test setup', when: [1792654200, -180],
      files: { 'README.md': documented.join('\n'), 'payments.js': client.join('\n'), 'server.key': privateKeyPem } },
    { message: SECURITY_FIX_MESSAGE, when: [1793000100, -120],
      files: { 'README.md': documented.join('\n'), 'payments.js': client.join('\n') } },
  ];
  let parent = null;
  const commits = plan.map(entry => {
    const person = nathaniel(entry.when[0], entry.when[1]);
    const tree = treeOid(entry.files);
    const body = `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author ${signature(person)}\ncommitter ${signature(person)}\n\n${entry.message}\n`;
    const oid = hex(gitHash('commit', Buffer.from(body)));
    const commit = { oid, tree, parent, author: person, committer: person, message: entry.message, files: entry.files };
    parent = oid;
    return commit;
  });
  return {
    fixture: 'room2-git-v1', branch: 'main', keyPath: 'server.key',
    notes: ['message is passed to isomorphic-git commit() as is; git stores it with a trailing newline.',
      'timezoneOffset follows isomorphic-git: minutes, positive west of UTC (-180 is +03:00).',
      'oid, tree and parent are the expected hashes when the commits are rebuilt with isomorphic-git.'],
    commits,
  };
}

// ---------------------------------------------------------------- assembly
function buildScenario() {
  const privateKeyPem = readFileSync(keyPath, 'utf8');
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const certDer = certificate(privateKey, publicKey);
  const certPem = wrapPem('CERTIFICATE', certDer);
  const tls = buildTls(privateKey, publicKey, certDer);
  const git = buildGit(privateKeyPem);
  const scenario = {
    cardNumber: tls.cardNumber,
    privateKeyPem,
    certificatePem: certPem,
    rsa: { modulusHex: tls.modulusHex, publicExponent: tls.exponent, encryptedPmsHex: hex(tls.encryptedPms), expectedPmsHex: hex(tls.pms) },
    tls: {
      cipherSuite: CIPHER_SUITE.name, cipherSuiteId: `0x${CIPHER_SUITE.id.toString(16).padStart(4, '0')}`,
      clientRandomHex: hex(tls.clientRandom), serverRandomHex: hex(tls.serverRandom),
      records: tls.records.map(entry => ({ direction: entry.direction, contentType: entry.contentType,
        sequence: entry.sequence, fragmentHex: hex(entry.fragment) })),
    },
    captureEncrypted: renderCapture(tls, false),
    captureDecrypted: renderCapture(tls, true),
  };
  const gitJson = `${JSON.stringify(git, null, 2)}\n`;
  const generated = '// Generated by scripts/room2/generate.js. Do not edit; regenerate and commit.\n'
    + '// Synthetic puzzle material only: the key, certificate, capture and card are fictional, not real credentials.\n'
    + `export const room2Scenario = ${JSON.stringify(scenario, null, 2)};\n`;
  return { scenario, git, artifacts: [{ path: gitFixturePath, content: gitJson }, { path: scenarioPath, content: generated }] };
}

function main(argv) {
  const { artifacts } = buildScenario();
  if (argv.includes('--check')) {
    const stale = artifacts.filter(artifact => { try { return readFileSync(artifact.path, 'utf8') !== artifact.content; } catch { return true; } });
    if (stale.length) throw new Error(`Room 2 artifacts are out of date: ${stale.map(item => path.relative(root, item.path)).join(', ')}`);
    process.stdout.write('Room 2 artifacts match a fresh generation.\n');
    return;
  }
  for (const artifact of artifacts) writeFileSync(artifact.path, artifact.content);
  process.stdout.write(`Wrote ${artifacts.map(item => path.relative(root, item.path)).join(', ')}\n`);
}

module.exports = { buildScenario, gitFixturePath, scenarioPath, SECURITY_FIX_MESSAGE };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
