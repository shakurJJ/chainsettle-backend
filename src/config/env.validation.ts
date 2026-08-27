import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  // Server
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  // Route prefix without version segment (versioning adds /v1, /v2). Legacy "api/v1" is accepted.
  API_PREFIX: Joi.string().default('api'),

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

  // Stellar
  STELLAR_NETWORK: Joi.string().valid('testnet', 'mainnet', 'futurenet').default('testnet'),
  STELLAR_RPC_URL: Joi.string().uri().required(),
  STELLAR_HORIZON_URL: Joi.string().uri().required(),
  CHAINSETTTLE_CONTRACT_ID: Joi.string().required(),
  USDC_TOKEN_ADDRESS: Joi.string().required(),
  STELLAR_SECRET_KEY: Joi.string().required(),

  // Email
  SMTP_HOST: Joi.string().required(),
  SMTP_PORT: Joi.number().integer().min(1).max(65535).default(587),
  SMTP_USER: Joi.string().required(),
  SMTP_PASS: Joi.string().required(),
  EMAIL_FROM: Joi.string().required(),

  // Rate Limiting
  THROTTLE_TTL: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),

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
}).options({ allowUnknown: true });
