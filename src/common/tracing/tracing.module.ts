/**
 * TracingModule
 *
 * Provides the TracingInterceptor as a module-level provider so it can
 * be registered as a global interceptor in AppModule.
 *
 * The module itself does NOT call initTracing() — that must happen in
 * main.ts BEFORE NestFactory.create() so that auto-instrumentation patches
 * fire before any http/https/net require() calls inside NestJS bootstrap.
 */

import { Module } from '@nestjs/common';
import { TracingInterceptor } from './tracing.interceptor';

@Module({
  providers: [TracingInterceptor],
  exports: [TracingInterceptor],
})
export class TracingModule {}
