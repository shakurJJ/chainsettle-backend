import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IpfsService } from '../../common/ipfs/ipfs.service';

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
