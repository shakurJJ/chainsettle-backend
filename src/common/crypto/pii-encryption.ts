import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const CURRENT_KEY_VERSION_ENV = 'PII_ENCRYPTION_KEY_VERSION';
const KEY_ENV_PREFIX = 'PII_ENCRYPTION_KEY_V';
const BLIND_INDEX_ENV = 'PII_BLIND_INDEX_KEY';

/**
 * Application-level encryption for PII fields (email addresses, KYC references).
 *
 * Ciphertext format: `v<version>:<base64(iv | authTag | ciphertext)>`
 * The version prefix enables key rotation: new writes use the current key while
 * older ciphertexts remain decryptable with their historical key.
 */
export class PiiEncryption {
  private readonly keys: Map<number, Buffer>;
  private readonly currentVersion: number;
  private readonly blindIndexKey: Buffer;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.keys = new Map();
    for (const [name, value] of Object.entries(env)) {
      if (!name.startsWith(KEY_ENV_PREFIX) || !value) {
        continue;
      }
      const version = Number.parseInt(name.slice(KEY_ENV_PREFIX.length), 10);
      if (!Number.isInteger(version) || version < 1) {
        continue;
      }
      this.keys.set(version, this.parseKey(value, name));
    }

    const configuredVersion = env[CURRENT_KEY_VERSION_ENV];
    this.currentVersion = configuredVersion
      ? Number.parseInt(configuredVersion, 10)
      : Math.max(0, ...this.keys.keys());

    if (!this.keys.has(this.currentVersion)) {
      throw new Error(
        `PII encryption key version ${this.currentVersion} is not configured (expected ${KEY_ENV_PREFIX}${this.currentVersion})`,
      );
    }

    const blindIndexSecret = env[BLIND_INDEX_ENV];
    if (!blindIndexSecret) {
      throw new Error(`${BLIND_INDEX_ENV} must be set to compute blind indexes`);
    }
    this.blindIndexKey = this.parseKey(blindIndexSecret, BLIND_INDEX_ENV);
  }

  private parseKey(value: string, name: string): Buffer {
    const key = /^[0-9a-fA-F]{64}$/.test(value)
      ? Buffer.from(value, 'hex')
      : Buffer.from(value, 'base64');
    if (key.length !== KEY_LENGTH) {
      throw new Error(`${name} must decode to ${KEY_LENGTH} bytes for AES-256`);
    }
    return key;
  }

  encrypt(plaintext: string): string {
    const key = this.keys.get(this.currentVersion)!;
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, authTag, ciphertext]).toString('base64');
    return `v${this.currentVersion}:${payload}`;
  }

  decrypt(encoded: string): string {
    const separator = encoded.indexOf(':');
    if (separator < 0 || !encoded.startsWith('v')) {
      throw new Error('Malformed PII ciphertext');
    }
    const version = Number.parseInt(encoded.slice(1, separator), 10);
    const key = this.keys.get(version);
    if (!key) {
      throw new Error(`No PII encryption key configured for version ${version}`);
    }
    const payload = Buffer.from(encoded.slice(separator + 1), 'base64');
    const iv = payload.subarray(0, IV_LENGTH);
    const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /**
   * Deterministic, keyed hash used for equality lookups on encrypted fields.
   * Normalizes email casing/whitespace so lookups are stable.
   */
  blindIndex(value: string): string {
    const normalized = value.trim().toLowerCase();
    return createHash('sha256')
      .update(this.blindIndexKey)
      .update(normalized, 'utf8')
      .digest('hex');
  }
}

let defaultInstance: PiiEncryption | undefined;

export function getPiiEncryption(): PiiEncryption {
  if (!defaultInstance) {
    defaultInstance = new PiiEncryption();
  }
  return defaultInstance;
}
