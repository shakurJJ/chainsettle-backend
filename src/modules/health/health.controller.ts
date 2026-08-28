import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IpfsService } from '../../common/ipfs/ipfs.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { RedisService } from '../../common/redis/redis.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as nodemailer from 'nodemailer';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly ipfsService: IpfsService,
  ) {}

  /**
   * GET /health
   * Combined liveness + readiness check (kept for backward compatibility).
   * Existing monitoring pointed at this endpoint continues to work unchanged.
   */
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Check API, database, and IPFS connectivity' })
  check() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      () => this.ipfsHealthCheck(),
    ]);
  }

  /**
   * GET /health/live
   * Kubernetes liveness probe — confirms the HTTP server is responsive.
   * Does NOT check any external dependencies (DB, Redis, IPFS) — a transient
   * dependency failure should never trigger a pod restart.
   * Always returns 200 unless the process itself is unresponsive.
   */
  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe — confirms the HTTP server is up (no dependency checks)',
  })
  live() {
    return { status: 'ok' };
  }

  /**
   * GET /health/ready
   * Kubernetes readiness probe — confirms all critical dependencies are reachable.
   * Returns 503 when the database (or IPFS) check fails, signalling the load
   * balancer to remove this pod from rotation until dependencies recover.
   */
  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness probe — checks DB and IPFS; returns 503 if any dependency is down',
  })
  ready() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      () => this.ipfsHealthCheck(),
    ]);
  }

  private ipfsHealthCheck(): HealthIndicatorResult {
    const status = this.ipfsService.isHealthy ? 'up' : 'down';
    return { ipfs: { status } };
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/health')
export class AdminHealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ipfsService: IpfsService,
    private readonly redis: RedisService,
    private readonly stellar: StellarService,
    private readonly config: ConfigService,
  ) {}

  @Get('dependencies')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Get status of all external dependencies' })
  async dependenciesSummary() {
    const dependencies = await Promise.all([
      this.databaseHealthCheck(),
      this.redisHealthCheck(),
      this.stellarHealthCheck(),
      this.ipfsHealthCheck(),
      this.smtpHealthCheck(),
      this.fxHealthCheck(),
      this.kycHealthCheck(),
    ]);

    const failing = dependencies.filter((dep) => dep.status !== 'up' && dep.status !== 'unknown');
    return {
      status: failing.length === 0 ? 'ok' : 'degraded',
      checkedAt: new Date().toISOString(),
      dependencies,
    };
  }

  private async databaseHealthCheck() {
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { name: 'database', status: 'up', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString() };
    } catch (error) {
      return { name: 'database', status: 'down', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString(), message: error.message };
    }
  }

  private async redisHealthCheck() {
    const startedAt = Date.now();
    try {
      const result = await this.redis.getClient().ping();
      return { name: 'redis', status: result === 'PONG' ? 'up' : 'down', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString() };
    } catch (error) {
      return { name: 'redis', status: 'down', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString(), message: error.message };
    }
  }

  private async stellarHealthCheck() {
    const startedAt = Date.now();
    try {
      const client: any = this.stellar.getClient();
      if (typeof client.getHealth === 'function') {
        await client.getHealth();
      } else if (typeof client.getLatestLedger === 'function') {
        await client.getLatestLedger();
      }
      return { name: 'stellar-rpc', status: 'up', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString() };
    } catch (error) {
      return { name: 'stellar-rpc', status: 'down', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString(), message: error.message };
    }
  }

  private async ipfsHealthCheck() {
    const startedAt = Date.now();
    try {
      const status = this.ipfsService.isHealthy ? 'up' : 'down';
      return { name: 'ipfs', status, latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString() };
    } catch (error) {
      return { name: 'ipfs', status: 'down', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString(), message: error.message };
    }
  }

  private async smtpHealthCheck() {
    const startedAt = Date.now();
    try {
      const host = this.config.get<string>('SMTP_HOST');
      if (!host) {
        return { name: 'smtp', status: 'unknown', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString(), message: 'SMTP is not configured' };
      }

      const transporter = nodemailer.createTransport({
        host,
        port: this.config.get<number>('SMTP_PORT', 587),
        secure: false,
        auth: {
          user: this.config.get<string>('SMTP_USER'),
          pass: this.config.get<string>('SMTP_PASS'),
        },
      });
      await transporter.verify();
      return { name: 'smtp', status: 'up', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString() };
    } catch (error) {
      return { name: 'smtp', status: 'down', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString(), message: error.message };
    }
  }

  private async fxHealthCheck() {
    const startedAt = Date.now();
    const apiUrl = this.config.get<string>('FX_RATE_API_URL');
    if (!apiUrl) {
      return { name: 'fx-rate-source', status: 'unknown', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString(), message: 'FX rate source is not configured' };
    }

    try {
      await axios.get(apiUrl, { timeout: 5000, params: { symbol: 'USDC' } });
      return { name: 'fx-rate-source', status: 'up', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString() };
    } catch (error) {
      return { name: 'fx-rate-source', status: 'down', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString(), message: error.message };
    }
  }

  private async kycHealthCheck() {
    const startedAt = Date.now();
    const provider = this.config.get<string>('KYC_PROVIDER_URL');
    if (!provider) {
      return { name: 'kyc-provider', status: 'unknown', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString(), message: 'KYC provider endpoint is not configured in this backend' };
    }

    try {
      await axios.get(provider, { timeout: 5000 });
      return { name: 'kyc-provider', status: 'up', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString() };
    } catch (error) {
      return { name: 'kyc-provider', status: 'down', latencyMs: Date.now() - startedAt, lastCheckedAt: new Date().toISOString(), message: error.message };
    }
  }
}
