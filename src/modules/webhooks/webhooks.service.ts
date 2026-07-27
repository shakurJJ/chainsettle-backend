import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';
import axios from 'axios';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { NotificationType } from '@prisma/client';
import { CreateWebhookDto } from './dto/create-webhook.dto';

const MAX_ATTEMPTS = 3;
const MAX_DELIVERY_RESPONSE_BODY_LENGTH = 10 * 1024; // 10KB, guards against pathological receivers

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async register(userId: string, dto: CreateWebhookDto) {
    const plaintext = crypto.randomBytes(32).toString('hex');
    const hashed = crypto.createHash('sha256').update(plaintext).digest('hex');

    const endpoint = await this.prisma.webhookEndpoint.create({
      data: { userId, url: dto.url, secret: hashed, events: dto.events },
    });

    // Plaintext secret returned once — never persisted
    return { ...endpoint, secret: plaintext };
  }

  findForUser(userId: string) {
    return this.prisma.webhookEndpoint.findMany({
      where: { userId },
      select: { id: true, url: true, events: true, active: true, createdAt: true },
    });
  }

  async findOneWithSummary(userId: string, id: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, userId },
      select: { id: true, url: true, events: true, active: true, createdAt: true },
    });

    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');

    const recentDeliveries = await this.prisma.webhookDelivery.findMany({
      where: { endpointId: id },
      orderBy: { id: 'desc' },
      take: 20,
      select: { statusCode: true, deliveredAt: true },
    });

    const total = recentDeliveries.length;
    const successCount = recentDeliveries.filter(
      (d) => d.statusCode !== null && d.statusCode >= 200 && d.statusCode < 300,
    ).length;
    const failureCount = total - successCount;
    const lastDeliveryAt = recentDeliveries.reduce<Date | null>((latest, d) => {
      if (!d.deliveredAt) return latest;
      return !latest || d.deliveredAt > latest ? d.deliveredAt : latest;
    }, null);

    return {
      ...endpoint,
      recentDeliveries: { total, successCount, failureCount, lastDeliveryAt },
    };
  }

  async remove(id: string, userId: string) {
    const ep = await this.prisma.webhookEndpoint.findFirst({ where: { id, userId } });
    if (!ep) throw new NotFoundException('Webhook endpoint not found');
    return this.prisma.webhookEndpoint.delete({ where: { id } });
  }

  async rotateSecret(id: string, userId: string) {
    const ep = await this.prisma.webhookEndpoint.findFirst({ where: { id } });
    if (!ep) throw new NotFoundException('Webhook endpoint not found');
    if (ep.userId !== userId) throw new ForbiddenException('Not the endpoint owner');

    const plaintext = crypto.randomBytes(32).toString('hex');
    const hashed = crypto.createHash('sha256').update(plaintext).digest('hex');

    await this.prisma.webhookEndpoint.update({
      where: { id },
      data: { secret: hashed },
    });

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { stellarAddress: true } });

    await this.auditLog.record({
      actorId: userId,
      actorAddress: user?.stellarAddress ?? 'unknown',
      action: 'WEBHOOK_SECRET_ROTATED',
      resourceType: 'WebhookEndpoint',
      resourceId: id,
    });

    this.logger.log(`Webhook secret rotated for endpoint ${id} by user ${userId}`);
    return { secret: plaintext };
  }

  async dispatch(eventType: NotificationType, payload: Record<string, any>) {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { active: true, events: { has: eventType } },
    });
    await Promise.allSettled(endpoints.map((ep) => this.attempt(ep, eventType, payload, 1)));
  }

  async getDelivery(userId: string, endpointId: string, deliveryId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, userId },
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');

    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, endpointId },
    });
    if (!delivery) throw new NotFoundException('Webhook delivery not found');

    return {
      ...delivery,
      responseBody: delivery.responseBody?.slice(0, MAX_DELIVERY_RESPONSE_BODY_LENGTH) ?? delivery.responseBody,
    };
  }

  async retryDelivery(endpointId: string, deliveryId: string, userId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, userId },
    });

    if (!endpoint) {
      throw new ForbiddenException('Only the endpoint owner can retry deliveries');
    }

    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, endpointId },
    });

    if (!delivery) {
      throw new NotFoundException('Webhook delivery not found');
    }

    const body = JSON.stringify({ eventType: delivery.eventType, payload: delivery.payload, timestamp: new Date().toISOString() });
    const signature = `sha256=${crypto.createHmac('sha256', endpoint.secret).update(body).digest('hex')}`;

    try {
      const res = await axios.post(endpoint.url, body, {
        headers: { 'Content-Type': 'application/json', 'X-ChainSettle-Signature': signature },
        timeout: 10_000,
      });

      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          statusCode: res.status,
          responseBody: String(res.data ?? '').slice(0, 1000),
          deliveredAt: new Date(),
          attemptCount: delivery.attemptCount + 1,
        },
      });
    } catch (err) {
      const statusCode: number | null = err.response?.status ?? null;
      const responseBody = String(err.response?.data ?? err.message ?? '').slice(0, 1000);

      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          statusCode,
          responseBody,
          attemptCount: delivery.attemptCount + 1,
        },
      });
    }

    return { message: 'Webhook delivery retried' };
  }

  private async attempt(
    ep: { id: string; url: string; secret: string },
    eventType: string,
    payload: Record<string, any>,
    attemptNumber: number,
  ) {
    const body = JSON.stringify({ eventType, payload, timestamp: new Date().toISOString() });
    const signature = `sha256=${crypto.createHmac('sha256', ep.secret).update(body).digest('hex')}`;

    const delivery = await this.prisma.webhookDelivery.create({
      data: { endpointId: ep.id, eventType, payload, attemptCount: attemptNumber },
    });

    try {
      const res = await axios.post(ep.url, body, {
        headers: { 'Content-Type': 'application/json', 'X-ChainSettle-Signature': signature },
        timeout: 10_000,
      });

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          statusCode: res.status,
          responseBody: String(res.data ?? '').slice(0, 1000),
          deliveredAt: new Date(),
        },
      });
    } catch (err) {
      const statusCode: number | null = err.response?.status ?? null;
      const responseBody = String(err.response?.data ?? err.message ?? '').slice(0, 1000);

      if (attemptNumber < MAX_ATTEMPTS) {
        const delayMs = 2 ** attemptNumber * 5_000; // 10 s, 20 s
        const nextRetryAt = new Date(Date.now() + delayMs);

        await this.prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { statusCode, responseBody, nextRetryAt },
        });

        setTimeout(() => this.attempt(ep, eventType, payload, attemptNumber + 1), delayMs);
      } else {
        await this.prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { statusCode, responseBody },
        });
        this.logger.warn(`Webhook ${ep.id} failed after ${MAX_ATTEMPTS} attempts`);
      }
    }
  }
}
