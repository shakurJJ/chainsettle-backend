import { registerAs } from '@nestjs/config';

export type SecretsProvider = 'env' | 'aws' | 'vault';

interface SecretCacheEntry {
  value: string;
  expiresAt: number;
}

const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
const secretCache = new Map<string, SecretCacheEntry>();

function getSecretsProvider(): SecretsProvider {
  const raw = (process.env.SECRETS_PROVIDER || 'env').toLowerCase();
  if (raw === 'aws' || raw === 'vault') {
    return raw;
  }
  return 'env';
}

function getConfiguredSecretKeys(): string[] {
  const raw = process.env.SECRETS_KEYS || '';
  return raw
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

async function fetchFromAws(key: string): Promise<string | undefined> {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!region) {
    return undefined;
  }
  try {
    // Lazy require so the SDK is only loaded when the aws provider is selected.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({ region });
    const result = await client.send(new GetSecretValueCommand({ SecretId: key }));
    if (typeof result.SecretString === 'string') {
      return result.SecretString;
    }
    if (result.SecretBinary) {
      return Buffer.from(result.SecretBinary).toString('utf8');
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function fetchFromVault(key: string): Promise<string | undefined> {
  const address = process.env.VAULT_ADDR;
  const token = process.env.VAULT_TOKEN;
  if (!address || !token) {
    return undefined;
  }
  try {
    const response = await fetch(`${address.replace(/\/$/, '')}/v1/${key.replace(/^\//, '')}`, {
      headers: { 'X-Vault-Token': token },
    });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as { data?: { value?: string; data?: Record<string, string> } };
    if (body.data && typeof body.data.value === 'string') {
      return body.data.value;
    }
    if (body.data && body.data.data) {
      const first = Object.values(body.data.data)[0];
      if (typeof first === 'string') {
        return first;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function resolveSecret(provider: SecretsProvider, key: string): Promise<string | undefined> {
  if (provider === 'env') {
    return process.env[key];
  }
  const cached = secretCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const value = provider === 'aws' ? await fetchFromAws(key) : await fetchFromVault(key);
  if (typeof value === 'string') {
    secretCache.set(key, { value, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
  }
  return value;
}

/**
 * Resolves configured secret keys from the selected provider and injects them
 * into process.env so they are available before Joi validation runs.
 * Values are cached and refreshed after the TTL to support rotated secrets.
 */
export async function loadSecrets(): Promise<void> {
  const provider = getSecretsProvider();
  const keys = getConfiguredSecretKeys();
  if (provider === 'env' || keys.length === 0) {
    return;
  }
  await Promise.all(
    keys.map(async (key) => {
      const value = await resolveSecret(provider, key);
      if (typeof value === 'string') {
        process.env[key] = value;
      }
    }),
  );
}

export function clearSecretCache(): void {
  secretCache.clear();
}

export default registerAs('app', () => ({
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  secretsProvider: getSecretsProvider(),
}));
