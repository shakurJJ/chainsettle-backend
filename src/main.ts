// ── OpenTelemetry must be initialised before any other import that touches
//    Node.js built-in modules (http, https, net).  The call is a no-op when
//    OTEL_EXPORTER_OTLP_ENDPOINT is not set.
import { initTracing } from './common/tracing/tracing';
initTracing();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, RequestMethod, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import * as compression from 'compression';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { createWinstonLogger } from './common/logger/winston.logger';
import * as fs from 'fs';
import * as path from 'path';

async function bootstrap() {
  const winstonLogger = createWinstonLogger();

  process.on('uncaughtException', (err) => {
    winstonLogger.error(`Uncaught exception: ${err.message}`, err.stack, 'UncaughtException');
  });
  process.on('unhandledRejection', (reason: any) => {
    winstonLogger.error(
      `Unhandled rejection: ${reason?.message ?? reason}`,
      reason?.stack,
      'UnhandledRejection',
    );
  });

  const app = await NestFactory.create(AppModule, { logger: winstonLogger });
  const logger = winstonLogger;

  // Use Socket.io adapter for WebSocket gateways
  app.useWebSocketAdapter(new IoAdapter(app));

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  // Prefix is "api"; URI versioning appends /v1, /v2, etc.
  // Legacy API_PREFIX=api/v1 is normalized to "api" so existing .env files keep working.
  const rawPrefix = configService.get<string>('API_PREFIX', 'api');
  const apiPrefix = rawPrefix.replace(/\/v\d+$/, '') || 'api';
  const allowedOrigins = configService
    .get<string>('ALLOWED_ORIGINS')
    ?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Backwards compatible fallback for older env setups.
  const fallbackOrigin = configService.get<string>('CORS_ORIGIN', 'http://localhost:5173');

  // Helmet — tuned for production security headers.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: false,
      },
      noSniff: true,
      frameguard: { action: 'deny' },
      xssFilter: true,
    }),
  );

  // Gzip compression — compress responses larger than 1 KB
  app.use(compression({ threshold: 1024 }));

  // Ensure X-Powered-By is not present (belt-and-suspenders; helmet does this by default).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const expressApp = app.getHttpAdapter().getInstance() as any;
  if (expressApp?.disable) {
    expressApp.disable('x-powered-by');
  }

  // CORS — strict origin allowlist.
  app.enableCors({
    origin:
      allowedOrigins && allowedOrigins.length > 0
        ? allowedOrigins
        : [fallbackOrigin],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: [
      'X-Request-ID',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ],
    credentials: true,
  });

  // Global prefix for all routes — /metrics is excluded so Prometheus can scrape it without the prefix
  app.setGlobalPrefix(apiPrefix, {
    exclude: [{ path: 'metrics', method: RequestMethod.GET }],
  });

  // URI versioning: /api/v1/..., /api/v2/...  Controllers default to v1.
  // Add a v2 controller with @Controller({ path: '...', version: '2' }) without touching v1.
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Exception filters are registered via APP_FILTER in AppModule (i18n-aware)

  // Global response transform — wraps all responses in { success, data, timestamp }
  app.useGlobalInterceptors(new TransformInterceptor());

  // Swagger API docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('ChainSettle API')
    .setDescription(
      'Backend API for ChainSettle — milestone-based supply chain escrow on Stellar Soroban',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('shipments', 'Shipment lifecycle management')
    .addTag('milestones', 'Milestone proof and confirmation')
    .addTag('events', 'On-chain Stellar event feed')
    .addTag('notifications', 'User notifications')
    .addTag('auth', 'Authentication via Stellar address')
    .addTag('health', 'Health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  // When SDK_GENERATE=1, write OpenAPI JSON and exit (used by npm run generate:sdk).
  if (process.env.SDK_GENERATE === '1') {
    const outDir = path.resolve(process.cwd(), 'sdk');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'openapi.json');
    fs.writeFileSync(outFile, JSON.stringify(document, null, 2));
    logger.log(`OpenAPI schema written to ${outFile}`);
    await app.close();
    process.exit(0);
  }

  await app.listen(port);
  logger.log(`ChainSettle API running on http://localhost:${port}/${apiPrefix}/v1`);
  logger.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();