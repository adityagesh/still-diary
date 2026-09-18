import {
  createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual,
} from 'node:crypto';

export const FORMAT_VERSION = 1;
export const KEY_BYTES = 32;
export const SCRYPT_OPTIONS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface Kdf {
  name: 'scrypt';
  salt: string;
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

export interface Envelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function fields(value: Record<string, unknown>, allowed: readonly string[], required = allowed): void {
  if (Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error('Unsupported or missing fields in vault data.');
  }
}

export function decodeBase64(value: unknown, maximum: number, exact?: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4
    || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    throw new Error('Invalid or oversized base64 data in the vault.');
  }
  const data = Buffer.from(value, 'base64');
  if (data.length > maximum || (exact !== undefined && data.length !== exact)
    || data.toString('base64') !== value) {
    data.fill(0);
    throw new Error('Invalid encoded data length in the vault.');
  }
  return data;
}

export function validatePassphrase(passphrase: unknown): asserts passphrase is string {
  if (typeof passphrase !== 'string' || passphrase.length > 1024
    || Array.from(passphrase).length < 12 || Buffer.byteLength(passphrase, 'utf8') > 4096) {
    throw new Error('Use a passphrase of at least 12 characters and at most 1024 UTF-16 code units.');
  }
}

export function newKdf(): Kdf {
  return { name: 'scrypt', salt: randomBytes(32).toString('base64'), ...SCRYPT_OPTIONS };
}

export function validateKdf(value: unknown): Kdf {
  const kdf = record(value, 'KDF');
  fields(kdf, ['name', 'salt', 'N', 'r', 'p', 'maxmem']);
  if (kdf.name !== 'scrypt' || kdf.N !== SCRYPT_OPTIONS.N || kdf.r !== SCRYPT_OPTIONS.r
    || kdf.p !== SCRYPT_OPTIONS.p || kdf.maxmem !== SCRYPT_OPTIONS.maxmem) {
    throw new Error('Unsupported KDF settings. This version requires the fixed safe scrypt parameters.');
  }
  decodeBase64(kdf.salt, 32, 32).fill(0);
  return kdf as unknown as Kdf;
}

export async function derivePassphraseKey(passphrase: string, value: Kdf): Promise<Buffer> {
  validatePassphrase(passphrase);
  const kdf = validateKdf(value);
  const password = Buffer.from(passphrase, 'utf8');
  const salt = decodeBase64(kdf.salt, 32, 32);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, KEY_BYTES, SCRYPT_OPTIONS, (error, key) => {
        if (error) {
          key?.fill(0);
          reject(new Error('Unable to derive the vault key. Check available memory.', { cause: error }));
        } else {
          resolve(key);
        }
      });
    });
  } finally {
    password.fill(0);
    salt.fill(0);
  }
}

export function validateEnvelope(value: unknown, maximum: number, exact?: number): Envelope {
  const envelope = record(value, 'Encrypted envelope');
  fields(envelope, ['version', 'algorithm', 'iv', 'tag', 'ciphertext']);
  if (envelope.version !== FORMAT_VERSION || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('Unsupported encrypted envelope version or algorithm.');
  }
  decodeBase64(envelope.iv, 12, 12).fill(0);
  decodeBase64(envelope.tag, 16, 16).fill(0);
  decodeBase64(envelope.ciphertext, maximum, exact).fill(0);
  return envelope as unknown as Envelope;
}

function aad(diaryId: string, purpose: string, logicalPath: string): Buffer {
  if (!UUID_PATTERN.test(diaryId)) throw new Error('Invalid diary identity.');
  return Buffer.from(JSON.stringify(['still-diary', FORMAT_VERSION, diaryId, purpose, logicalPath]), 'utf8');
}

export function encrypt(
  key: Buffer, plaintext: Buffer, diaryId: string, purpose: string, logicalPath: string,
): Envelope {
  if (key.length !== KEY_BYTES) throw new Error('Invalid encryption key length.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(diaryId, purpose, logicalPath));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: FORMAT_VERSION,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decrypt(
  key: Buffer, value: unknown, diaryId: string, purpose: string, logicalPath: string, maximum: number,
): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('Invalid decryption key length.');
  const envelope = validateEnvelope(value, maximum);
  const iv = decodeBase64(envelope.iv, 12, 12);
  const tag = decodeBase64(envelope.tag, 16, 16);
  const ciphertext = decodeBase64(envelope.ciphertext, maximum);
  let partial: Buffer | undefined;
  let final: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad(diaryId, purpose, logicalPath));
    decipher.setAuthTag(tag);
    partial = decipher.update(ciphertext);
    final = decipher.final();
    return Buffer.concat([partial, final]);
  } catch {
    throw new Error('Authentication failed: the key is incorrect or the encrypted vault data was changed.');
  } finally {
    partial?.fill(0);
    final?.fill(0);
    ciphertext.fill(0);
    iv.fill(0);
    tag.fill(0);
  }
}

function recoveryChecksum(key: Buffer): Buffer {
  return createHash('sha256').update('still-diary/recovery/v1\0').update(key).digest().subarray(0, 4);
}

export function encodeRecoveryKey(key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error('Invalid recovery key length.');
  const checksum = recoveryChecksum(key);
  try {
    return `SDRK1-${key.toString('hex').toUpperCase().match(/.{8}/g)!.join('-')}-${checksum.toString('hex').toUpperCase()}`;
  } finally {
    checksum.fill(0);
  }
}

export function parseRecoveryKey(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Invalid recovery key format.');
  const text = value.trim();
  if (!/^SDRK1-(?:[0-9A-F]{8}-){8}[0-9A-F]{8}$/.test(text)) {
    throw new Error('Recovery keys start with SDRK1 and contain nine groups of eight uppercase hexadecimal characters.');
  }
  const groups = text.slice(6).split('-');
  const key = Buffer.from(groups.slice(0, 8).join(''), 'hex');
  const supplied = Buffer.from(groups[8], 'hex');
  const expected = recoveryChecksum(key);
  try {
    if (!timingSafeEqual(supplied, expected)) {
      key.fill(0);
      throw new Error('Recovery key checksum does not match. Check the copied key.');
    }
    return key;
  } finally {
    supplied.fill(0);
    expected.fill(0);
  }
}
