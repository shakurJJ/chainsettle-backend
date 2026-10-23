import * as Joi from 'joi';
import { CronTime } from 'cron';

const cronExpression = Joi.string()
  .custom((value: string, helpers) => {
    try {
      new CronTime(value);
      return value;
    } catch (_err) {
      return helpers.error('any.invalid');
    }
  })
  .messages({ 'any.invalid': '{{#label}} must be a valid cron expression' });

const jsonObjectString = Joi.string()
  .custom((value: string, helpers) => {
    try {
      const parsed = JSON.parse(value);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return helpers.error('any.invalid');
      }
      return value;
    } catch (_err) {
      return helpers.error('any.invalid');
    }
  })
  .messages({ 'any.invalid': '{{#label}} must be a JSON object string' });

export const envValidationSchema = Joi.object({
  // Server
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  // Route prefix without version segment (versioning adds /v1, /v2). Legacy "api/v1" is accepted.
  API_PREFIX: Joi.string().default('api'),

  // Logging — winston npm levels. When unset, defaults to 'info' in production and 'debug' otherwise.
  LOG_LEVEL: Joi.string()
    .valid('error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly')
    .optional(),

  // OpenTelemetry tracing — fully disabled when OTEL_EXPORTER_OTLP_ENDPOINT is unset or empty.
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().uri({ scheme: ['http', 'https'] }).allow('').optional(),
  // JSON object of extra OTLP request headers, e.g. {"x-honeycomb-team":"KEY"}
  OTEL_EXPORTER_OTLP_HEADERS: jsonObjectString.allow('').optional(),
  OTEL_SERVICE_NAME: Joi.string().optional(),

  // JWT
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRES_IN: Joi.string().default('7d'),
  /** Short-lived TTL for admin impersonation tokens (default 15m). */
  IMPERSONATION_JWT_EXPIRES_IN: Joi.string().default('15m'),

  // Database
  DATABASE_URL: Joi.string()
    .pattern(/^postgres(ql)?:\/\//)
    .required()
    .messages({ 'string.pattern.base': 'DATABASE_URL must start with postgresql:// or postgres://' }),
  // Optional read replica. When unset, all queries use DATABASE_URL (primary).
  DATABASE_REPLICA_URL: Joi.string()
    .pattern(/^postgres(ql)?:\/\//)
    .optional()
    .messages({ 'string.pattern.base': 'DATABASE_REPLICA_URL must start with postgresql:// or postgres://' }),
  DATABASE_CONNECTION_LIMIT: Joi.number().integer().min(1).max(1000).default(10),
  DATABASE_POOL_TIMEOUT: Joi.number().integer().min(1).max(300).default(10),

  // Cold-storage archival of completed/cancelled shipments (days; default 90)
  SHIPMENT_ARCHIVAL_DAYS: Joi.number().integer().min(1).max(3650).default(90),
  // Cron schedule for the archival job (default: daily at 03:00 server time)
  SHIPMENT_ARCHIVAL_CRON: cronExpression.default('0 3 * * *'),

  // Nightly deletion of read notifications older than this many days (default 90)
  NOTIFICATION_RETENTION_DAYS: Joi.number().integer().min(1).max(3650).default(90),

  // Stellar
  STELLAR_NETWORK: Joi.string().valid('testnet', 'mainnet', 'futurenet').default('testnet'),
  STELLAR_RPC_URL: Joi.string().uri(),
  STELLAR_HORIZON_URL: Joi.string().uri(),
  // Comma-separated failover lists; take precedence over the single-URL vars
  STELLAR_RPC_URLS: Joi.string(),
  STELLAR_HORIZON_URLS: Joi.string(),
  STELLAR_HEALTH_INTERVAL_MS: Joi.number().integer().min(1000).default(15000),
  CHAINSETTTLE_CONTRACT_ID: Joi.string().required(),
  USDC_TOKEN_ADDRESS: Joi.string().required(),
  STELLAR_SECRET_KEY: Joi.string().required(),

  // Email
  EMAIL_WEBHOOK_SECRET: Joi.string().optional(),
  MAX_JSON_DEPTH: Joi.number().integer().min(1).default(20),
  SMTP_HOST: Joi.string().required(),
  SMTP_PORT: Joi.number().integer().min(1).max(65535).default(587),
  SMTP_USER: Joi.string().required(),
  SMTP_PASS: Joi.string().required(),
  EMAIL_FROM: Joi.string().required(),

  // Rate Limiting
  THROTTLE_TTL: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),
  THROTTLE_LIMIT_VERIFIED: Joi.number().integer().min(1).default(250),
  THROTTLE_LIMIT_ADMIN: Joi.number().integer().min(1).default(500),

  // Redis
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),

  // IPFS (Pinata)
  IPFS_GATEWAY_URL: Joi.string().uri().default('https://gateway.pinata.cloud/ipfs'),
  IPFS_API_KEY: Joi.string().allow('').default(''),
  IPFS_HEALTH_CHECK_INTERVAL_MS: Joi.number().integer().min(1000).default(60000),
  IPFS_MAX_UPLOAD_SIZE_BYTES: Joi.number().integer().min(1024).default(50 * 1024 * 1024),
  IPFS_ALLOWED_MIME_TYPES: Joi.string().allow('').optional(),

  // Event Polling
  EVENT_POLLING_INTERVAL_MS: Joi.number().integer().min(1000).default(5000),

  // CORS
  ALLOWED_ORIGINS: Joi.string().default('http://localhost:5173'),
  CORS_ORIGIN: Joi.string().default('http://localhost:5173'),

  // API Base URL
  API_BASE_URL: Joi.string().uri().default('http://localhost:3000'),

  // Development
  SLOW_QUERY_THRESHOLD_MS: Joi.number().integer().min(0).default(100),

  // Webhooks
  WEBHOOK_DELIVERY_TIMEOUT_MS: Joi.number().integer().min(1000).max(600000).default(10000),
  WEBHOOK_MAX_PAYLOAD_BYTES: Joi.number().integer().min(1024).max(50 * 1024 * 1024).default(256 * 1024),
  WEBHOOK_HEADERS_ENCRYPTION_KEY: Joi.string().length(32).default('change-me-webhook-headers-key!!!!'),

  // KYC/AML (#233)
  // Shipments with totalAmount (in stroops) at or above this threshold require
  // both buyer and supplier to have a VERIFIED kycStatus.
  KYC_VALUE_THRESHOLD_STROOPS: Joi.string().default('1000000000000'), // 100,000 USDC at 7 decimals

  // Shipments with totalAmount at or above this (higher) threshold require the
  // "enhanced" KYC tier (additional documents) rather than the "basic" tier. See #285.
  KYC_ENHANCED_VALUE_THRESHOLD_STROOPS: Joi.string().default('10000000000000'), // 1,000,000 USDC at 7 decimals

  // Signing key for calendar subscription tokens (#236). Rotating it revokes
  // every issued feed URL.
  CALENDAR_FEED_SECRET: Joi.string().allow('').default(''),

  // Shipments at or above this value may require multi-signature approval (#234)
  MULTISIG_VALUE_THRESHOLD_STROOPS: Joi.string().default('1000000000000'), // 100,000 USDC at 7 decimals
  KYC_WEBHOOK_SECRET: Joi.string().allow('').default(''),
  // How long a VERIFIED KYC status remains valid before re-verification is required (#429).
  KYC_VALIDITY_DAYS: Joi.number().integer().min(1).default(365),
  // GraphQL cost controls (#432)
  GRAPHQL_MAX_DEPTH: Joi.number().integer().min(1).default(7),
  GRAPHQL_MAX_COMPLEXITY: Joi.number().integer().min(1).default(1000),

  // FX rate service (#231)
  FX_RATE_API_URL: Joi.string().uri().allow('').optional(),
  FX_RATE_CACHE_TTL_SECONDS: Joi.number().integer().min(1).default(300),
  // How many minutes after the last successful fetch a rate is considered stale.
  // Defaults to the cache TTL window (5 minutes). Stale rates are still served
  // but the response includes `stale: true` so clients can warn users.
  FX_STALE_AFTER_MINUTES: Joi.number().integer().min(1).default(10),
  // FX provider circuit breaker: consecutive failures before the provider is
  // skipped, and how long it is skipped for before a trial call is allowed.
  FX_BREAKER_FAILURE_THRESHOLD: Joi.number().integer().min(1).default(5),
  FX_BREAKER_COOLDOWN_SECONDS: Joi.number().integer().min(1).default(60),

  // Milestone deadline reminders (#491)
  // Days after dueAt when the initial overdue notification is sent (default 0: immediate)
  OVERDUE_REMINDER_1_DAYS: Joi.number().integer().min(0).max(365).default(0),
  // Days after initial reminder when the escalation notification is sent (default 3)
  OVERDUE_REMINDER_3_DAYS: Joi.number().integer().min(0).max(365).default(3),

  // Dispute escalation (#491)
  // Days a milestone can remain in DISPUTED status before admins are alerted (default 7)
  DISPUTE_ESCALATION_DAYS: Joi.number().integer().min(1).max(365).default(7),
})
  .or('STELLAR_RPC_URL', 'STELLAR_RPC_URLS')
  .or('STELLAR_HORIZON_URL', 'STELLAR_HORIZON_URLS')
  .options({ allowUnknown: true });
