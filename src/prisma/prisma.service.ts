import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const PII_FIELDS = ['email', 'kycReference'] as const;
type PiiField = (typeof PII_FIELDS)[number];

const ENCRYPTED_PREFIX = 'enc:v';

function getEncryptionKey(version: number): Buffer {
  const raw = process.env[`PII_ENCRYPTION_KEY_V${version}`] ?? (version === 1 ? process.env.PII_ENCRYPTION_KEY : undefined);
  if (!raw) {
    throw new Error(`Missing PII encryption key for version ${version}`);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`PII encryption key for version ${version} must be 32 bytes (AES-256)`);
  }
  return key;
}

function currentKeyVersion(): number {
  return Number(process.env.PII_ENCRYPTION_KEY_VERSION ?? '1');
}

function encryptValue(plaintext: string): string {
  const version = currentKeyVersion();
  const key = getEncryptionKey(version);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${version}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptValue(stored: string): string {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) {
    return stored;
  }
  const parts = stored.split(':');
  // enc : v<version> : iv : tag : ciphertext
  const version = Number(parts[1].slice(1));
  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const ciphertext = Buffer.from(parts[4], 'base64');
  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(version), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function blindIndex(value: string): string {
  const secret = process.env.PII_BLIND_INDEX_KEY ?? process.env.PII_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('Missing PII blind index key');
  }
  return createHash('sha256').update(`${secret}:${value.toLowerCase()}`).digest('hex');
}

function isPiiField(field: string): field is PiiField {
  return (PII_FIELDS as readonly string[]).includes(field);
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super();
    this.$use(async (params, next) => {
      if (params.model === 'User') {
        if (params.action === 'findUnique' || params.action === 'findFirst' || params.action === 'findMany') {
          const where = params.args?.where;
          if (where && typeof where.email === 'string') {
            where.email = blindIndex(where.email);
          }
        }
        if (params.action === 'create' || params.action === 'update' || params.action === 'upsert') {
          const data = params.action === 'upsert' ? params.args?.create : params.args?.data;
          if (data && typeof data === 'object') {
            for (const field of PII_FIELDS) {
              const value = (data as Record<string, unknown>)[field];
              if (typeof value === 'string' && !value.startsWith(ENCRYPTED_PREFIX)) {
                (data as Record<string, unknown>)[field] = encryptValue(value);
              }
            }
            if (typeof (data as Record<string, unknown>).email === 'string') {
              (data as Record<string, unknown>).emailBlindIndex = blindIndex(
                decryptValue((data as Record<string, unknown>).email as string),
              );
            }
          }
        }
      }

      const result = await next(params);

      if (params.model === 'User' && result) {
        const decryptRow = (row: Record<string, unknown>) => {
          for (const field of PII_FIELDS) {
            const value = row[field];
            if (typeof value === 'string') {
              row[field] = decryptValue(value);
            }
          }
          return row;
        };
        if (Array.isArray(result)) {
          result.forEach((row) => row && typeof row === 'object' && decryptRow(row as Record<string, unknown>));
        } else if (typeof result === 'object') {
          decryptRow(result as Record<string, unknown>);
        }
      }

      return result;
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
