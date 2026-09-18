import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeBase64, decrypt, derivePassphraseKey, encodeRecoveryKey, encrypt, newKdf, parseRecoveryKey,
  SCRYPT_OPTIONS, validateEnvelope, validateKdf, validatePassphrase,
} from '../electron/crypto';

describe('authenticated vault encryption', () => {
  const diaryId = randomUUID();
  const filename = 'entries/2026/09/2026-09-18.entry';
  const message = Buffer.from('A secret that must remain private.');

  it('round trips with random IVs and authenticated metadata', () => {
    const key = randomBytes(32);
    try {
      const first = encrypt(key, message, diaryId, 'entry', filename);
      const second = encrypt(key, message, diaryId, 'entry', filename);
      expect(first.iv).not.toBe(second.iv);
      expect(first.ciphertext).not.toBe(second.ciphertext);
      const plaintext = decrypt(key, first, diaryId, 'entry', filename, 1024);
      expect(plaintext).toEqual(message);
      plaintext.fill(0);
      expect(() => decrypt(key, first, randomUUID(), 'entry', filename, 1024)).toThrow(/Authentication/);
      expect(() => decrypt(key, first, diaryId, 'asset', filename, 1024)).toThrow(/Authentication/);
      expect(() => decrypt(key, first, diaryId, 'entry', filename + '.other', 1024)).toThrow(/Authentication/);
      expect(() => decrypt(randomBytes(32), first, diaryId, 'entry', filename, 1024)).toThrow(/Authentication/);
    } finally { key.fill(0); }
  });

  it.each(['iv', 'tag', 'ciphertext'] as const)('rejects tampered %s', (field) => {
    const key = randomBytes(32);
    try {
      const envelope = encrypt(key, message, diaryId, 'entry', filename);
      const changed = Buffer.from(envelope[field], 'base64');
      changed[0] ^= 1;
      envelope[field] = changed.toString('base64');
      expect(() => decrypt(key, envelope, diaryId, 'entry', filename, 1024)).toThrow(/Authentication/);
    } finally { key.fill(0); }
  });

  it('rejects unsupported algorithms, versions, keys, sizes, and noncanonical encodings', () => {
    const key = randomBytes(32);
    try {
      const envelope = encrypt(key, message, diaryId, 'entry', filename);
      expect(() => validateEnvelope({ ...envelope, version: 2 }, 1024)).toThrow(/Unsupported/);
      expect(() => validateEnvelope({ ...envelope, algorithm: 'aes-256-cbc' }, 1024)).toThrow(/Unsupported/);
      expect(() => validateEnvelope({ ...envelope, extra: true }, 1024)).toThrow(/fields/);
      expect(() => validateEnvelope({ ...envelope, tag: '' }, 1024)).toThrow(/length/);
      expect(() => validateEnvelope(envelope, 1)).toThrow(/base64/);
      expect(() => decrypt(Buffer.alloc(16), envelope, diaryId, 'entry', filename, 1024)).toThrow(/key length/);
      expect(() => encrypt(Buffer.alloc(16), message, diaryId, 'entry', filename)).toThrow(/key length/);
      expect(() => encrypt(key, message, '../bad', 'entry', filename)).toThrow(/identity/);
      for (const encoding of ['abcd\n', 'YQ', 'YQ===', 'YR==', '====', 'é===', 'Y=Q=']) {
        expect(() => decodeBase64(encoding, 1024)).toThrow();
      }
    } finally { key.fill(0); }
  });

  it('handles multi-megabyte base64 without recursive regexp exhaustion', () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 7);
    const decoded = decodeBase64(bytes.toString('base64'), bytes.length);
    expect(decoded).toEqual(bytes);
    bytes.fill(0);
    decoded.fill(0);
  });
});

describe('scrypt passphrase wrapping', () => {
  it('uses fixed bounded costs and an independently random salt', async () => {
    const kdf = newKdf();
    expect(kdf).toMatchObject({ name: 'scrypt', ...SCRYPT_OPTIONS });
    expect(Buffer.from(kdf.salt, 'base64')).toHaveLength(32);
    expect(kdf.salt).not.toEqual(newKdf().salt);
    const first = await derivePassphraseKey('twelve words are not required', kdf);
    const again = await derivePassphraseKey('twelve words are not required', kdf);
    const different = await derivePassphraseKey('a different valid passphrase', kdf);
    try {
      expect(first).toHaveLength(32);
      expect(first).toEqual(again);
      expect(first).not.toEqual(different);
    } finally {
      first.fill(0);
      again.fill(0);
      different.fill(0);
    }
  });

  it.each([
    { N: 2 ** 30 }, { r: 512 }, { p: 1000 }, { maxmem: 2 ** 40 }, { name: 'pbkdf2' },
    { N: 16384 }, { salt: 'short' }, { salt: Buffer.alloc(16).toString('base64') },
  ])('rejects untrusted KDF parameters %j before deriving', async (change) => {
    const kdf = { ...newKdf(), ...change };
    expect(() => validateKdf(kdf)).toThrow();
    await expect(derivePassphraseKey('a sufficiently long passphrase', kdf as ReturnType<typeof newKdf>)).rejects.toThrow();
  });

  it('bounds passphrases without trimming or normalizing their secret content', () => {
    expect(() => validatePassphrase('a'.repeat(12))).not.toThrow();
    expect(() => validatePassphrase('a'.repeat(1024))).not.toThrow();
    expect(() => validatePassphrase('a'.repeat(11))).toThrow(/12/);
    expect(() => validatePassphrase('a'.repeat(1025))).toThrow(/1024/);
    expect(() => validatePassphrase('🔐'.repeat(6))).toThrow(/12/);
    expect(() => validatePassphrase('🔐'.repeat(12))).not.toThrow();
    expect(() => validatePassphrase(null)).toThrow(/passphrase/);
  });
});

describe('copyable recovery keys', () => {
  it('round trips a random 256-bit key with prefix, groups, and checksum', () => {
    const key = randomBytes(32);
    try {
      const encoded = encodeRecoveryKey(key);
      expect(encoded).toMatch(/^SDRK1-(?:[0-9A-F]{8}-){8}[0-9A-F]{8}$/);
      const recovered = parseRecoveryKey(` ${encoded}\n`);
      expect(recovered).toEqual(key);
      recovered.fill(0);
    } finally { key.fill(0); }
  });

  it('rejects typing mistakes, altered checksum, ambiguous formats, and extra data', () => {
    const key = randomBytes(32);
    try {
      const encoded = encodeRecoveryKey(key);
      const replacement = encoded[6] === '0' ? '1' : '0';
      expect(() => parseRecoveryKey(encoded.slice(0, 6) + replacement + encoded.slice(7))).toThrow(/checksum/);
      const checksumReplacement = encoded.endsWith('0') ? '1' : '0';
      expect(() => parseRecoveryKey(encoded.slice(0, -1) + checksumReplacement)).toThrow(/checksum/);
      for (const invalid of [encoded.toLowerCase(), encoded.replace('SDRK1', 'SDRK2'), encoded + '-00000000', encoded.replaceAll('-', ''), '', 'a'.repeat(500)]) {
        expect(() => parseRecoveryKey(invalid)).toThrow();
      }
      expect(() => parseRecoveryKey(123)).toThrow(/format/);
      expect(() => encodeRecoveryKey(Buffer.alloc(16))).toThrow(/length/);
    } finally { key.fill(0); }
  });
});
