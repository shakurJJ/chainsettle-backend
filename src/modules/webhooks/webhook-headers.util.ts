import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** Encrypts a single value. Returns base64 string: iv:authTag:ciphertext */
export function encryptHeaderValue(value: string, key: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key, 'utf8'), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/** Decrypts a value that was encrypted with encryptHeaderValue */
export function decryptHeaderValue(encrypted: string, key: string): string {
  const [ivB64, tagB64, ctB64] = encrypted.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key, 'utf8'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
]);

export function isReservedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_HEADERS.has(lower) || lower.startsWith('x-chainsettle-');
}

export const MAX_HEADERS = 10;
export const MAX_HEADERS_TOTAL_BYTES = 1024;

export interface HeaderValidationError {
  message: string;
}

export function validateHeaders(headers: Record<string, string>): HeaderValidationError | null {
  const entries = Object.entries(headers);

  if (entries.length > MAX_HEADERS) {
    return { message: `Too many headers: max ${MAX_HEADERS} allowed` };
  }

  let totalBytes = 0;
  for (const [name, value] of entries) {
    if (!name || typeof name !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      return { message: `Invalid header name: "${name}"` };
    }
    if (typeof value !== 'string') {
      return { message: `Invalid header value for "${name}": must be a string` };
    }
    if (isReservedHeader(name)) {
      return { message: `Header "${name}" is reserved and cannot be set` };
    }
    totalBytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8');
    if (totalBytes > MAX_HEADERS_TOTAL_BYTES) {
      return { message: `Headers exceed ${MAX_HEADERS_TOTAL_BYTES} bytes total (names + values)` };
    }
  }

  return null;
}

export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    result[name] = '••••••••';
  }
  return result;
}

export function encryptHeaders(headers: Record<string, string>, key: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = encryptHeaderValue(value, key);
  }
  return result;
}

export function decryptHeaders(headers: Record<string, string> | null | undefined, key: string): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    try {
      result[name] = decryptHeaderValue(value, key);
    } catch {
      // Skip values that can't be decrypted (corrupted data, wrong key, etc.)
    }
  }
  return result;
}
