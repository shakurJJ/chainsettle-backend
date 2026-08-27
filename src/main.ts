import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, RequestMethod } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import * as compression from 'compression';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ThrottlerExceptionFilter } from './common/filters/throttler-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { createWinstonLogger } from './common/logger/winston.logger';

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
  const apiPrefix = configService.get<string>('API_PREFIX', 'api/v1');
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

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global exception filter — standardised error responses
  app.useGlobalFilters(
    new HttpExceptionFilter(),
    new ThrottlerExceptionFilter(),
  );

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

  await app.listen(port);
  logger.log(`ChainSettle API running on http://localhost:${port}/${apiPrefix}`);
  logger.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();