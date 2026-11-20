import * as Joi from 'joi';

/**
 * Pluggable secrets providers. `env` is the default and preserves the
 * historical behaviour of reading secrets from plain environment variables.
 */
export type SecretsProvider = 'env' | 'aws' | 'vault';

export interface SecretsProviderConfig {
  provider: SecretsProvider;
  /** Comma-separated list of secret keys to resolve before validation. */
  keys: string[];
  /** Optional refresh interval (ms) for rotated secrets. 0 disables refresh. */
  refreshIntervalMs: number;
}

interface CachedSecret {
  value: string;
  expiresAt: number;
}

const secretCache = new Map<string, CachedSecret>();

function parseProvider(raw: string | undefined): SecretsProvider {
  const value = (raw || 'env').toLowerCase();
  if (value === 'aws' || value === 'vault' || value === 'env') {
    return value;
  }
  // Unknown providers fall back to env so the app can still boot.
  return 'env';
}

function parseKeys(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

function parseRefreshInterval(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

export function getSecretsProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): SecretsProviderConfig {
  return {
    provider: parseProvider(env.SECRETS_PROVIDER),
    keys: parseKeys(env.SECRETS_KEYS),
    refreshIntervalMs: parseRefreshInterval(env.SECRETS_REFRESH_INTERVAL_MS),
  };
}

/**
 * Resolve a single secret from the configured provider. Providers are loaded
 * lazily so that the AWS/Vault SDKs are only required when actually used.
 */
async function fetchSecret(
  provider: SecretsProvider,
  key: string,
): Promise<string | undefined> {
  if (provider === 'env') {
    return process.env[key];
  }

  if (provider === 'aws') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
    const result = await client.send(new GetSecretValueCommand({ SecretId: key }));
    return result.SecretString ?? undefined;
  }

  // vault
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vault = require('node-vault');
  const client = vault({
    apiVersion: 'v1',
    endpoint: process.env.VAULT_ADDR,
    token: process.env.VAULT_TOKEN,
  });
  const result = await client.read(key);
  const data = result && result.data ? result.data : {};
  const firstKey = Object.keys(data)[0];
  return firstKey ? String(data[firstKey]) : undefined;
}

/**
 * Resolve all configured secret keys into `process.env` before Joi validation
 * runs. Values are cached and refreshed according to the configured interval
 * so rotated secrets are picked up without a restart. Secrets are never logged.
 */
export async function resolveSecrets(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = getSecretsProviderConfig(env);
  if (config.provider === 'env' || config.keys.length === 0) {
    return;
  }

  const now = Date.now();
  await Promise.all(
    config.keys.map(async (key) => {
      const cached = secretCache.get(key);
      if (cached && cached.expiresAt > now) {
        env[key] = cached.value;
        return;
      }

      try {
        const value = await fetchSecret(config.provider, key);
        if (value === undefined) {
          return;
        }
        secretCache.set(key, {
          value,
          expiresAt: config.refreshIntervalMs > 0 ? now + config.refreshIntervalMs : Number.MAX_SAFE_INTEGER,
        });
        env[key] = value;
      } catch (error) {
        // Do not log secret values; surface only the key that failed.
        // eslint-disable-next-line no-console
        console.error(`Failed to resolve secret "${key}" from ${config.provider} provider`);
      }
    }),
  );
}

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test', 'provision')
    .default('development'),
  PORT: Joi.number().default(3000),
  SECRETS_PROVIDER: Joi.string()
    .valid('env', 'aws', 'vault')
    .default('env'),
  SECRETS_KEYS: Joi.string().allow('').optional(),
  SECRETS_REFRESH_INTERVAL_MS: Joi.number().min(0).optional(),
});
