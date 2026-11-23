import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { UpdateWebhookDto } from './dto/update-webhook.dto';
import { WebhookEvent } from './webhook-events.enum';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAllForUser(userId: string) {
    return this.prisma.webhookEndpoint.findMany({
      where: { userId, organizationId: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createForUser(userId: string, dto: CreateWebhookDto) {
    return this.prisma.webhookEndpoint.create({
      data: {
        userId,
        url: dto.url,
        events: dto.events,
        secret: dto.secret,
        active: dto.active ?? true,
      },
    });
  }

  async updateForUser(userId: string, id: string, dto: UpdateWebhookDto) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, userId, organizationId: null },
    });
    if (!endpoint) {
      throw new NotFoundException('Webhook endpoint not found');
    }
    return this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        url: dto.url,
        events: dto.events,
        secret: dto.secret,
        active: dto.active,
      },
    });
  }

  async removeForUser(userId: string, id: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, userId, organizationId: null },
    });
    if (!endpoint) {
      throw new NotFoundException('Webhook endpoint not found');
    }
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    return { success: true };
  }

  async findAllForOrganization(organizationId: string) {
    return this.prisma.webhookEndpoint.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createForOrganization(
    organizationId: string,
    userId: string,
    dto: CreateWebhookDto,
  ) {
    await this.assertOrganizationAdmin(organizationId, userId);
    return this.prisma.webhookEndpoint.create({
      data: {
        organizationId,
        userId,
        url: dto.url,
        events: dto.events,
        secret: dto.secret,
        active: dto.active ?? true,
      },
    });
  }

  async updateForOrganization(
    organizationId: string,
    userId: string,
    id: string,
    dto: UpdateWebhookDto,
  ) {
    await this.assertOrganizationAdmin(organizationId, userId);
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, organizationId },
    });
    if (!endpoint) {
      throw new NotFoundException('Webhook endpoint not found');
    }
    return this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        url: dto.url,
        events: dto.events,
        secret: dto.secret,
        active: dto.active,
      },
    });
  }

  async removeForOrganization(
    organizationId: string,
    userId: string,
    id: string,
  ) {
    await this.assertOrganizationAdmin(organizationId, userId);
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, organizationId },
    });
    if (!endpoint) {
      throw new NotFoundException('Webhook endpoint not found');
    }
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    return { success: true };
  }

  private async assertOrganizationAdmin(organizationId: string, userId: string) {
    const membership = await this.prisma.organizationMember.findFirst({
      where: { organizationId, userId },
    });
    if (!membership || membership.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Only organization admins can manage organization webhooks',
      );
    }
  }

  async dispatch(event: WebhookEvent, payload: Record<string, any>) {
    const userId = payload.userId as string | undefined;
    const organizationId = payload.organizationId as string | undefined;

    const or: Array<Record<string, any>> = [];
    if (userId) {
      or.push({ userId, organizationId: null });
    }
    if (organizationId) {
      or.push({ organizationId });
    }
    if (or.length === 0) {
      return;
    }

    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: {
        active: true,
        events: { has: event },
        OR: or,
      },
    });

    // Deduplicate by endpoint id so a user and org webhook never double-deliver.
    const unique = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));

    await Promise.all(
      Array.from(unique.values()).map((endpoint) =>
        this.deliver(endpoint, event, payload).catch((error) => {
          this.logger.error(
            `Failed to deliver webhook ${endpoint.id} for ${event}: ${error.message}`,
          );
        }),
      ),
    );
  }

  private async deliver(
    endpoint: { id: string; url: string; secret: string | null },
    event: WebhookEvent,
    payload: Record<string, any>,
  ) {
    const body = JSON.stringify({ event, data: payload });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (endpoint.secret) {
      const { createHmac } = await import('crypto');
      headers['X-Webhook-Signature'] = createHmac('sha256', endpoint.secret)
        .update(body)
        .digest('hex');
    }
    await fetch(endpoint.url, { method: 'POST', headers, body });
  }
}
