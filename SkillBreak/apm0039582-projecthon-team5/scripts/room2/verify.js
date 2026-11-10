'use strict';
// Offline verification of the committed Room 2 scenario (R2-01): git key recovery, key/certificate match,
// PMS decryption, TLS 1.2 record decryption, Luhn-valid card, and no early secrets in the encrypted capture.
//   node scripts/room2/verify.js
const { createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, constants, privateDecrypt, X509Certificate } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { gitFixturePath, scenarioPath, SECURITY_FIX_MESSAGE } = require('./generate');

function loadCommitted() {
  const fixtureBytes = readFileSync(gitFixturePath);
  const source = readFileSync(scenarioPath, 'utf8');
  const scenario = JSON.parse(source.slice(source.indexOf('room2Scenario = ') + 'room2Scenario = '.length).replace(/;\s*$/, ''));
  return { fixtureBytes, scenario };
}

function assert(condition, message) { if (!condition) throw new Error(`Room 2 scenario check failed: ${message}`); }

const gitHash = (type, body) => createHash('sha1').update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body])).digest();
const sha256 = data => createHash('sha256').update(data).digest();

function prf(secret, label, seed, length) {
  const labelSeed = Buffer.concat([Buffer.from(label), seed]);
  const parts = [];
  for (let a = labelSeed, total = 0; total < length; total += 32) {
    a = createHmac('sha256', secret).update(a).digest();
    parts.push(createHmac('sha256', secret).update(a).update(labelSeed).digest());
  }
  return Buffer.concat(parts).subarray(0, length);
}

function luhnValid(number) {
  const total = [...number].reverse().reduce((sum, char, index) => {
    const digit = Number(char) * (index % 2 === 1 ? 2 : 1);
    return sum + (digit > 9 ? digit - 9 : digit);
  }, 0);
  return /^\d{16}$/.test(number) && total % 10 === 0;
}

/** Node refuses PKCS#1 v1.5 privateDecrypt, so decrypt raw and check the padding by hand. */
function decryptPms(privateKey, encrypted) {
  const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, encrypted);
  assert(block[0] === 0 && block[1] === 2, 'PMS block is not PKCS#1 v1.5 type 2');
  const end = block.indexOf(0, 2);
  assert(end >= 10, 'PMS padding is too short');
  return block.subarray(end + 1);
}

function decryptRecords(pmsBuffer, tls) {
  const clientRandom = Buffer.from(tls.clientRandomHex, 'hex');
  const serverRandom = Buffer.from(tls.serverRandomHex, 'hex');
  const master = prf(pmsBuffer, 'master secret', Buffer.concat([clientRandom, serverRandom]), 48);
  const block = prf(master, 'key expansion', Buffer.concat([serverRandom, clientRandom]), 40);
  const keys = { client: { key: block.subarray(0, 16), salt: block.subarray(32, 36) }, server: { key: block.subarray(16, 32), salt: block.subarray(36, 40) } };
  return tls.records.map(entry => {
    const fragment = Buffer.from(entry.fragmentHex, 'hex');
    const { key, salt } = keys[entry.direction];
    const body = fragment.subarray(8, fragment.length - 16);
    const aad = Buffer.alloc(13);
    aad.writeBigUInt64BE(BigInt(entry.sequence), 0);
    aad.writeUInt8(entry.contentType, 8);
    aad.writeUInt16BE(0x0303, 9);
    aad.writeUInt16BE(body.length, 11);
    const decipher = createDecipheriv('aes-128-gcm', key, Buffer.concat([salt, fragment.subarray(0, 8)]));
    decipher.setAAD(aad);
    decipher.setAuthTag(fragment.subarray(fragment.length - 16));
    return { ...entry, plaintext: Buffer.concat([decipher.update(body), decipher.final()]) };
  });
}

function verifyScenario({ fixtureBytes, scenario }) {
  const checks = [];
  const pass = (message) => checks.push(message);

  // Git: parent chain and hashes, key in HEAD~1 only, exact security-fix message.
  const git = JSON.parse(fixtureBytes.toString('utf8'));
  let parent = null;
  for (const commit of git.commits) {
    const entries = Object.keys(commit.files).sort().map(file =>
      Buffer.concat([Buffer.from(`100644 ${file}\0`), gitHash('blob', Buffer.from(commit.files[file]))]));
    const tree = gitHash('tree', Buffer.concat(entries)).toString('hex');
    const signature = person => `${person.name} <${person.email}> ${person.timestamp} ${person.timezoneOffset <= 0 ? '+' : '-'}${String(Math.abs(person.timezoneOffset) / 60 | 0).padStart(2, '0')}${String(Math.abs(person.timezoneOffset) % 60).padStart(2, '0')}`;
    const body = `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author ${signature(commit.author)}\ncommitter ${signature(commit.committer)}\n\n${commit.message}\n`;
    assert(commit.tree === tree && commit.parent === parent, `commit ${commit.message} tree/parent`);
    assert(commit.oid === gitHash('commit', Buffer.from(body)).toString('hex'), `commit ${commit.message} oid`);
    parent = commit.oid;
  }
  const head = git.commits[git.commits.length - 1];
  const previous = git.commits[git.commits.length - 2];
  assert(head.message === SECURITY_FIX_MESSAGE, 'latest commit message');
  assert(!(git.keyPath in head.files), 'HEAD still contains the key file');
  assert(previous.files[git.keyPath] === scenario.privateKeyPem, 'HEAD~1 does not contain the private key');
  pass(`git: ${git.commits.length} commits, HEAD "${head.message}", HEAD~1 holds ${git.keyPath}`);

  // Key and certificate.
  const privateKey = createPrivateKey(previous.files[git.keyPath]);
  const publicKey = createPublicKey(privateKey);
  const cert = new X509Certificate(scenario.certificatePem);
  assert(publicKey.asymmetricKeyDetails.modulusLength === 2048, 'RSA key is not 2048 bits');
  assert(cert.verify(cert.publicKey) && cert.checkIssued(cert), 'certificate is not self-signed');
  assert(cert.publicKey.export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' })), 'key does not match the certificate');
  const jwk = publicKey.export({ format: 'jwk' });
  assert(Buffer.from(jwk.n, 'base64url').toString('hex') === scenario.rsa.modulusHex, 'modulus differs from the certificate key');
  assert(scenario.rsa.publicExponent === 65537 && Buffer.from(jwk.e, 'base64url').readUIntBE(0, 3) === 65537, 'public exponent');
  pass('key: 2048-bit RSA key from git matches the self-signed certificate (N, e=65537)');

  // PMS.
  const pms = decryptPms(privateKey, Buffer.from(scenario.rsa.encryptedPmsHex, 'hex'));
  assert(pms.length === 48 && pms.readUInt16BE(0) === 0x0303 && pms.toString('hex') === scenario.rsa.expectedPmsHex, 'decrypted PMS');
  pass('rsa: private key decrypts the encrypted PMS (PKCS#1 v1.5) to the expected 48-byte PMS');

  // TLS records.
  let records;
  try { records = decryptRecords(pms, scenario.tls); } catch { assert(false, 'TLS records do not decrypt with the recovered PMS'); }
  assert(scenario.tls.cipherSuite === 'TLS_RSA_WITH_AES_128_GCM_SHA256' && scenario.tls.cipherSuiteId === '0x009c', 'cipher suite');
  const application = records.filter(entry => entry.contentType === 23).map(entry => entry.plaintext.toString()).join('\n');
  assert(application.includes(`"card_number":"${scenario.cardNumber}"`), 'card number in decrypted Application Data');
  assert(records.filter(entry => entry.contentType === 22).every(entry => entry.plaintext[0] === 20 && entry.plaintext.length === 16), 'Finished records');
  assert(luhnValid(scenario.cardNumber), 'card number is not Luhn-valid');
  const wrong = Buffer.from(pms); wrong[47] ^= 1;
  let rejected = false;
  try { decryptRecords(wrong, scenario.tls); } catch { rejected = true; }
  assert(rejected, 'a wrong PMS must not decrypt the records');
  pass(`tls: PRF keys decrypt ${records.length} records; Application Data holds the Luhn-valid card; a wrong PMS fails`);

  // Capture renderings.
  const encrypted = scenario.captureEncrypted;
  for (const visible of [scenario.tls.clientRandomHex, scenario.tls.serverRandomHex, scenario.rsa.modulusHex, scenario.rsa.encryptedPmsHex, scenario.tls.cipherSuite]) {
    assert(encrypted.includes(visible), 'encrypted capture misses a handshake value');
  }
  const body = Buffer.from(scenario.privateKeyPem.split('\n').filter(line => line && !line.startsWith('-----'))[1]);
  for (const secret of [scenario.cardNumber, scenario.rsa.expectedPmsHex, 'PRIVATE KEY', body.toString(), 'card_number', 'POST /api', 'Decrypted']) {
    assert(!encrypted.includes(secret), `encrypted capture leaks ${secret === scenario.cardNumber ? 'the card number' : secret}`);
  }
  assert(scenario.captureDecrypted.includes(scenario.cardNumber) && scenario.captureDecrypted.includes('Decrypted Application Data'), 'decrypted capture');
  pass('capture: encrypted text shows the handshake values only; decrypted text adds the Application Data and card');
  return checks;
}

module.exports = { verifyScenario, loadCommitted, luhnValid, decryptPms, decryptRecords };
if (require.main === module) {
  try { for (const line of verifyScenario(loadCommitted())) process.stdout.write(`ok  ${line}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
