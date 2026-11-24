import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import * as crypto from "crypto";
import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";
import { PrismaService } from "../../common/prisma/prisma.service";
import { MetricsService } from "../../common/metrics/metrics.service";
import { AuditLogService } from "../audit-logs/audit-log.service";
import { NotificationType, Prisma, WebhookEndpointStatus } from "@prisma/client";
import { CreateWebhookDto } from "./dto/create-webhook.dto";
import { UpdateWebhookDto } from "./dto/update-webhook.dto";
import {
  validateHeaders,
  encryptHeaders,
  decryptHeaders,
  maskHeaders,
} from "./webhook-headers.util";
import { requestIdStorage } from "../../common/middleware/request-id.middleware";
import { assertPublicWebhookUrl } from "./url-guard";

// ─── Retry policy ────────────────────────────────────────────────────────────

const MAX_AUTO_ATTEMPTS = 5;

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ERR_NETWORK",
]);

const DELIVERY_RESPONSE_BODY_MAX = 10 * 1024;

function baseDelaySeconds(attempt: number): number {
  return 30 * 4 ** (attempt - 1);
}

function withJitter(seconds: number): number {
  const jitter = (Math.random() - 0.5) * 0.5;
  return Math.round(seconds * (1 + jitter));
}

function nextRetryDate(attemptCount: number): Date {
  const delaySec = withJitter(baseDelaySeconds(attemptCount));
  return new Date(Date.now() + delaySec * 1_000);
}

function isRetryable(err: AxiosError | Error): boolean {
  const axiosErr = err as AxiosError;
  if (axiosErr.response) {
    return RETRYABLE_STATUS_CODES.has(axiosErr.response.status);
  }
  const code: string = (axiosErr as any).code ?? "";
  return RETRYABLE_ERROR_CODES.has(code) || axiosErr.code === "ECONNABORTED";
}

/** Event type used for batched deliveries (#638). payload is an array of events. */
export const BATCH_EVENT_TYPE = "webhook.batch";
export const VERIFICATION_EVENT_TYPE = "webhook.verification";
export const MAX_BATCH_SIZE = 100;

/**
 * POST to a webhook URL. Re-validates the target on every call (DNS rebinding
 * protection, #636) and refuses to follow redirects.
 */
async function postGuarded(
  url: string,
  body: string,
  config: AxiosRequestConfig,
): Promise<AxiosResponse> {
  await assertPublicWebhookUrl(url);
  return axios.post(url, body, { ...config, maxRedirects: 0 });
}

function buildBody(
  eventType: string,
  payload: unknown,
): string {
  return JSON.stringify({
    eventType,
    payload,
    timestamp: new Date().toISOString(),
  });
}

/** Legacy v1 signature — kept for one deprecation cycle.
 *  Signs only the raw JSON body. */
function signBody(secret: string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * V2 signature — includes a unix-seconds timestamp so consumers can reject
 * replayed deliveries older than their tolerance window (recommended: 300 s).
 *
 * Signed payload:  `${timestampSeconds}.${rawJsonBody}`
 * Header format:   `t=<unix-seconds>,v1=<hex-digest>`
 */
function signBodyV2(
  secret: string,
  timestampSeconds: number,
  body: string,
): string {
  const signedContent = `${timestampSeconds}.${body}`;
  const digest = crypto
    .createHmac("sha256", secret)
    .update(signedContent)
    .digest("hex");
  return `t=${timestampSeconds},v1=${digest}`;
}

/** Returns the current time as whole unix seconds. */
function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

interface EndpointWithOptionalEncryptedHeaders {
  id: string;
  url: string;
  secret: string;
  headers?: unknown;
  batchSize?: number | null;
  batchWindowMs?: number | null;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly deliveryTimeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly encryptionKey: string;

  /** In-memory batch buffers keyed by endpoint id (#638). */
  private readonly batches = new Map<
    string,
    {
      ep: EndpointWithOptionalEncryptedHeaders;
      events: unknown[];
      timer: NodeJS.Timeout | null;
    }
  >();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly metrics: MetricsService,
  ) {
    this.deliveryTimeoutMs = this.normalizePositiveInteger(
      this.config.get<number | string>("WEBHOOK_DELIVERY_TIMEOUT_MS", 10_000),
      10_000,
    );
    this.maxPayloadBytes = this.normalizePositiveInteger(
      this.config.get<number | string>("WEBHOOK_MAX_PAYLOAD_BYTES", 256 * 1024),
      256 * 1024,
    );
    this.encryptionKey = String(
      this.config.get<string>(
        "WEBHOOK_HEADERS_ENCRYPTION_KEY",
        "change-me-webhook-headers-key!!!!",
      ),
    );
  }

  private normalizePositiveInteger(
    value: number | string | undefined,
    fallback: number,
  ): number {
    const parsed = Number(value ?? fallback);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private recordDeliveryMetric(startedAt: number, statusCode: number | null) {
    const success = statusCode !== null && statusCode >= 200 && statusCode < 300;
    this.metrics.observeWebhookDelivery(success ? 'success' : 'failure', statusCode, (Date.now() - startedAt) / 1_000);
  }

  private preparePayloadForDelivery(
    eventType: string,
    payload: unknown,
  ) {
    const body = buildBody(eventType, payload);
    const bytes = Buffer.byteLength(body, "utf8");
    const exceedsLimit = bytes > this.maxPayloadBytes;

    if (exceedsLimit) {
      this.logger.warn(
        `[webhook] Skipping delivery for event ${eventType}: payload is ${bytes} bytes, exceeding configured max of ${this.maxPayloadBytes} bytes`,
      );
    }

    return { body, bytes, exceedsLimit };
  }

  private buildDeliveryHeaders(
    ep: EndpointWithOptionalEncryptedHeaders,
    ts: number,
    signature: string,
    signatureV2: string,
  ): Record<string, string> {
    const custom = decryptHeaders(
      ep.headers as Record<string, string> | null | undefined,
      this.encryptionKey,
    );
    const requestId = requestIdStorage.getStore();
    return {
      ...custom,
      "Content-Type": "application/json",
      "X-ChainSettle-Timestamp": String(ts),
      "X-ChainSettle-Signature": signature,
      "X-ChainSettle-Signature-V2": signatureV2,
      ...(requestId && { "X-Request-ID": requestId }),
    };
  }

  // ── Registration ───────────────────────────────────────────────────────────

  async register(userId: string, dto: CreateWebhookDto) {
    await assertPublicWebhookUrl(dto.url);

    if (dto.headers !== undefined) {
      const err = validateHeaders(dto.headers);
      if (err) throw new BadRequestException(`headers: ${err.message}`);
    }

    const plaintext = crypto.randomBytes(32).toString("hex");
    const hashed = crypto.createHash("sha256").update(plaintext).digest("hex");

    const encryptedHeaders = dto.headers
      ? (encryptHeaders(
          dto.headers,
          this.encryptionKey,
        ) as Prisma.InputJsonValue)
      : null;

    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        userId,
        url: dto.url,
        secret: hashed,
        events: dto.events,
        headers: encryptedHeaders,
        status: WebhookEndpointStatus.PENDING_VERIFICATION,
        batchSize: dto.batchSize ?? null,
        batchWindowMs: dto.batchSize ? (dto.batchWindowMs ?? 5_000) : null,
      },
    });

    // Attempt the challenge handshake right away; failure leaves it pending (#637)
    const verification = await this.runVerification(endpoint);

    return {
      id: endpoint.id,
      url: endpoint.url,
      events: endpoint.events,
      active: endpoint.active,
      status: verification.verified
        ? WebhookEndpointStatus.ACTIVE
        : endpoint.status,
      batchSize: endpoint.batchSize,
      batchWindowMs: endpoint.batchWindowMs,
      createdAt: endpoint.createdAt,
      headers: dto.headers ? maskHeaders(dto.headers) : undefined,
      secret: plaintext,
      verification,
    };
  }

  /** POST /webhooks/:id/verify — retry the challenge handshake. */
  async verify(id: string, userId: string) {
    const ep = await this.prisma.webhookEndpoint.findFirst({
      where: { id, userId },
    });
    if (!ep) throw new NotFoundException("Webhook endpoint not found");
    if (ep.status === WebhookEndpointStatus.ACTIVE) {
      return { verified: true, message: "Webhook endpoint already verified" };
    }
    return this.runVerification(ep);
  }

  /**
   * Sends a `webhook.verification` event carrying a random challenge. The
   * receiver must echo the challenge in its response body (either the raw
   * string or `{ "challenge": "..." }`). On success the endpoint becomes ACTIVE.
   */
  private async runVerification(ep: EndpointWithOptionalEncryptedHeaders) {
    const challenge = crypto.randomBytes(24).toString("hex");
    const body = buildBody(VERIFICATION_EVENT_TYPE, {
      challenge,
      endpointId: ep.id,
    });
    const ts = nowUnixSeconds();
    try {
      const res = await postGuarded(ep.url, body, {
        headers: this.buildDeliveryHeaders(
          ep,
          ts,
          signBody(ep.secret, body),
          signBodyV2(ep.secret, ts, body),
        ),
        timeout: this.deliveryTimeoutMs,
      });
      const data = res.data;
      const echoed =
        (typeof data === "string" && data.trim() === challenge) ||
        (typeof data === "object" &&
          data !== null &&
          (data as any).challenge === challenge);
      if (!echoed) {
        return {
          verified: false,
          message: "Endpoint did not echo the verification challenge",
        };
      }
      await this.prisma.webhookEndpoint.update({
        where: { id: ep.id },
        data: { status: WebhookEndpointStatus.ACTIVE, verifiedAt: new Date() },
      });
      return { verified: true, message: "Webhook endpoint verified" };
    } catch (err) {
      return {
        verified: false,
        message: `Verification request failed: ${(err as Error).message}`.slice(
          0,
          500,
        ),
      };
    }
  }

  async update(userId: string, id: string, dto: UpdateWebhookDto) {
    const existing = await this.prisma.webhookEndpoint.findFirst({
      where: { id, userId },
    });
    if (!existing) throw new NotFoundException("Webhook endpoint not found");

    if (dto.headers !== undefined) {
      const err = validateHeaders(dto.headers);
      if (err) throw new BadRequestException(`headers: ${err.message}`);
    }

    if (dto.url !== undefined) await assertPublicWebhookUrl(dto.url);

    const data: Prisma.WebhookEndpointUpdateInput = {};
    if (dto.url !== undefined) data.url = dto.url;
    if (dto.events !== undefined) data.events = dto.events;
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.headers !== undefined) {
      const cleared = Object.keys(dto.headers).length === 0;
      data.headers = cleared
        ? Prisma.AnyNull
        : (encryptHeaders(
            dto.headers,
            this.encryptionKey,
          ) as Prisma.InputJsonValue);
    }

    const updated = await this.prisma.webhookEndpoint.update({
      where: { id },
      data,
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stellarAddress: true },
    });

    await this.auditLog.record({
      actorId: userId,
      actorAddress: user?.stellarAddress ?? "unknown",
      action: "WEBHOOK_UPDATED",
      resourceType: "WebhookEndpoint",
      resourceId: id,
      metadata: { fields: Object.keys(data) },
    });

    const finalHeaders =
      dto.headers !== undefined
        ? Object.keys(dto.headers).length === 0
          ? undefined
          : maskHeaders(dto.headers)
        : updated.headers
          ? maskHeaders(
              decryptHeaders(
                updated.headers as Record<string, string>,
                this.encryptionKey,
              ),
            )
          : undefined;

    return {
      id: updated.id,
      url: updated.url,
      events: updated.events,
      active: updated.active,
      createdAt: updated.createdAt,
      headers: finalHeaders,
    };
  }

  findForUser(userId: string) {
    return this.prisma.webhookEndpoint
      .findMany({
        where: { userId },
        select: {
          id: true,
          url: true,
          events: true,
          active: true,
          status: true,
          batchSize: true,
          batchWindowMs: true,
          createdAt: true,
          headers: true,
        },
      })
      .then((list) =>
        list.map((ep) => ({
          id: ep.id,
          url: ep.url,
          events: ep.events,
          active: ep.active,
          status: ep.status,
          batchSize: ep.batchSize,
          batchWindowMs: ep.batchWindowMs,
          createdAt: ep.createdAt,
          headers: ep.headers
            ? maskHeaders(
                decryptHeaders(
                  ep.headers as Record<string, string>,
                  this.encryptionKey,
                ),
              )
            : undefined,
        })),
      );
  }

  async findOneWithSummary(userId: string, id: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, userId },
      select: {
        id: true,
        url: true,
        events: true,
        active: true,
        status: true,
        batchSize: true,
        batchWindowMs: true,
        createdAt: true,
        headers: true,
      },
    });

    if (!endpoint) throw new NotFoundException("Webhook endpoint not found");

    const recentDeliveries = await this.prisma.webhookDelivery.findMany({
      where: { endpointId: id },
      orderBy: { id: "desc" },
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
      id: endpoint.id,
      url: endpoint.url,
      events: endpoint.events,
      active: endpoint.active,
      status: endpoint.status,
      batchSize: endpoint.batchSize,
      batchWindowMs: endpoint.batchWindowMs,
      createdAt: endpoint.createdAt,
      headers: endpoint.headers
        ? maskHeaders(
            decryptHeaders(
              endpoint.headers as Record<string, string>,
              this.encryptionKey,
            ),
          )
        : undefined,
      recentDeliveries: { total, successCount, failureCount, lastDeliveryAt },
    };
  }

  async remove(id: string, userId: string) {
    const ep = await this.prisma.webhookEndpoint.findFirst({
      where: { id, userId },
    });
    if (!ep) throw new NotFoundException("Webhook endpoint not found");
    return this.prisma.webhookEndpoint.delete({ where: { id } });
  }

  async rotateSecret(id: string, userId: string) {
    const ep = await this.prisma.webhookEndpoint.findFirst({ where: { id } });
    if (!ep) throw new NotFoundException("Webhook endpoint not found");
    if (ep.userId !== userId)
      throw new ForbiddenException("Not the endpoint owner");

    const plaintext = crypto.randomBytes(32).toString("hex");
    const hashed = crypto.createHash("sha256").update(plaintext).digest("hex");

    await this.prisma.webhookEndpoint.update({
      where: { id },
      data: { secret: hashed },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stellarAddress: true },
    });

    await this.auditLog.record({
      actorId: userId,
      actorAddress: user?.stellarAddress ?? "unknown",
      action: "WEBHOOK_SECRET_ROTATED",
      resourceType: "WebhookEndpoint",
      resourceId: id,
    });

    this.logger.log(
      `Webhook secret rotated for endpoint ${id} by user ${userId}`,
    );
    return { secret: plaintext };
  }

  // ── Delivery ───────────────────────────────────────────────────────────────

  async dispatch(
    eventType: NotificationType,
    payload: Record<string, unknown>,
  ) {
    // Unverified (PENDING_VERIFICATION) endpoints receive no events (#637)
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: {
        active: true,
        status: WebhookEndpointStatus.ACTIVE,
        events: { has: eventType },
      },
    });
    await Promise.allSettled(
      endpoints.map((ep) =>
        ep.batchSize && ep.batchSize > 1
          ? this.enqueueBatch(ep, eventType as string, payload)
          : this.deliverOnce(ep, eventType as string, payload),
      ),
    );
  }

  /** Buffer an event; flush when batchSize is reached or batchWindowMs elapses (#638). */
  private async enqueueBatch(
    ep: EndpointWithOptionalEncryptedHeaders,
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    let batch = this.batches.get(ep.id);
    if (!batch) {
      batch = { ep, events: [], timer: null };
      this.batches.set(ep.id, batch);
    }
    batch.ep = ep;
    batch.events.push({ eventType, payload, timestamp: new Date().toISOString() });

    const size = Math.min(ep.batchSize ?? 1, MAX_BATCH_SIZE);
    if (batch.events.length >= size) {
      await this.flushBatch(ep.id);
    } else if (!batch.timer) {
      batch.timer = setTimeout(() => {
        this.flushBatch(ep.id).catch((err) =>
          this.logger.error(
            `Batch flush failed for ${ep.id}`,
            (err as Error).message,
          ),
        );
      }, ep.batchWindowMs ?? 5_000);
      batch.timer.unref?.();
    }
  }

  private async flushBatch(endpointId: string) {
    const batch = this.batches.get(endpointId);
    if (!batch || batch.events.length === 0) return;
    if (batch.timer) clearTimeout(batch.timer);
    this.batches.delete(endpointId);
    // One request, one signature over the whole array body
    await this.deliverOnce(batch.ep, BATCH_EVENT_TYPE, batch.events);
  }

  async getDelivery(userId: string, endpointId: string, deliveryId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, userId },
    });
    if (!endpoint) throw new NotFoundException("Webhook endpoint not found");

    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, endpointId },
    });
    if (!delivery) throw new NotFoundException("Webhook delivery not found");

    return {
      ...delivery,
      responseBody:
        delivery.responseBody?.slice(0, DELIVERY_RESPONSE_BODY_MAX) ?? null,
      retryStatus: this.describeRetryStatus(delivery),
    };
  }

  async getFailedDeliveries(
    userId: string,
    endpointId: string,
    page: number = 1,
    limit: number = 20,
  ) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, userId },
    });
    if (!endpoint) throw new NotFoundException("Webhook endpoint not found");

    const skip = (page - 1) * limit;
    const where = { endpointId, deliveredAt: null } as const;

    const [deliveries, total] = await Promise.all([
      this.prisma.webhookDelivery.findMany({
        where,
        orderBy: { id: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);

    return {
      data: deliveries.map((delivery) => ({
        ...delivery,
        responseBody:
          delivery.responseBody?.slice(0, DELIVERY_RESPONSE_BODY_MAX) ?? null,
        retryStatus: this.describeRetryStatus(delivery),
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async retryDelivery(endpointId: string, deliveryId: string, userId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, userId },
    });
    if (!endpoint) {
      throw new ForbiddenException(
        "Only the endpoint owner can retry deliveries",
      );
    }

    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, endpointId },
    });
    if (!delivery) throw new NotFoundException("Webhook delivery not found");

    const payloadCheck = this.preparePayloadForDelivery(
      delivery.eventType,
      delivery.payload as Record<string, unknown>,
    );
    const body = payloadCheck.body;
    const ts = nowUnixSeconds();
    const signature = signBody(endpoint.secret, body);
    const signatureV2 = signBodyV2(endpoint.secret, ts, body);

    const startedAt = Date.now();
    if (payloadCheck.exceedsLimit) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          statusCode: null,
          responseBody: `Payload exceeds max size (${payloadCheck.bytes}/${this.maxPayloadBytes} bytes)`,
          attemptCount: delivery.attemptCount + 1,
          nextRetryAt: null,
          permanentlyFailedAt: new Date(),
        },
      });
      this.recordDeliveryMetric(startedAt, null);

      this.logger.warn(
        `[webhook] Manual retry ${deliveryId} skipped for endpoint ${endpointId}: payload exceeds configured max of ${this.maxPayloadBytes} bytes`,
      );
      return { message: "Webhook delivery retried" };
    }

    try {
      const headers = this.buildDeliveryHeaders(
        endpoint,
        ts,
        signature,
        signatureV2,
      );
      const res = await postGuarded(endpoint.url, body, {
        headers,
        timeout: this.deliveryTimeoutMs,
      });

      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          statusCode: res.status,
          responseBody: String(res.data ?? "").slice(0, 1_000),
          deliveredAt: new Date(),
          attemptCount: delivery.attemptCount + 1,
          nextRetryAt: null,
          permanentlyFailedAt: null,
        },
      });
      this.recordDeliveryMetric(startedAt, res.status);
    } catch (err) {
      const statusCode: number | null =
        (err as AxiosError).response?.status ?? null;
      const responseBody = String(
        (err as AxiosError).response?.data ?? (err as Error).message ?? "",
      ).slice(0, 1_000);

      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          statusCode,
          responseBody,
          attemptCount: delivery.attemptCount + 1,
          permanentlyFailedAt: null,
        },
      });
      this.recordDeliveryMetric(startedAt, statusCode);
    }

    return { message: "Webhook delivery retried" };
  }

  async replayFailedDeliveries(endpointId: string, from: Date, to: Date) {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id: endpointId },
    });
    if (!endpoint) throw new NotFoundException("Webhook endpoint not found");

    const deliveries = await this.prisma.webhookDelivery.findMany({
      where: {
        endpointId,
        deliveredAt: null,
        createdAt: { gte: from, lte: to },
      },
      select: { id: true },
    });

    await Promise.allSettled(
      deliveries.map((d) =>
        this.retryDelivery(endpointId, d.id, endpoint.userId),
      ),
    );

    this.logger.log(
      `[admin-replay] Queued ${deliveries.length} failed delivery(ies) for endpoint ${endpointId} (${from.toISOString()} – ${to.toISOString()})`,
    );

    return {
      endpointId,
      from: from.toISOString(),
      to: to.toISOString(),
      deliveriesQueued: deliveries.length,
    };
  }

  private async sendTestPing(endpoint: {
    id: string;
    url: string;
    secret: string;
    headers?: unknown;
  }) {
    const bodyObj = { message: "This is a test ping from ChainSettle" };
    const payloadCheck = this.preparePayloadForDelivery(
      "WEBHOOK_TEST",
      bodyObj,
    );
    const startedAt = Date.now();

    if (payloadCheck.exceedsLimit) {
      return {
        endpointId: endpoint.id,
        success: false,
        statusCode: null,
        latencyMs: Date.now() - startedAt,
        error: `Payload exceeds max size (${payloadCheck.bytes}/${this.maxPayloadBytes} bytes)`,
      };
    }

    const ts = nowUnixSeconds();
    const signature = signBody(endpoint.secret, payloadCheck.body);
    const signatureV2 = signBodyV2(endpoint.secret, ts, payloadCheck.body);

    try {
      const res = await postGuarded(endpoint.url, payloadCheck.body, {
        headers: {
          "Content-Type": "application/json",
          "X-ChainSettle-Timestamp": String(ts),
          "X-ChainSettle-Signature": signature,
          "X-ChainSettle-Signature-V2": signatureV2,
        },
        timeout: this.deliveryTimeoutMs,
      });

      return {
        endpointId: endpoint.id,
        success: true,
        statusCode: res.status,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      const statusCode: number | null =
        (err as AxiosError).response?.status ?? null;
      const errorMessage = String(
        (err as AxiosError).response?.data ??
          (err as Error).message ??
          "Unknown error",
      ).slice(0, 1_000);

      return {
        endpointId: endpoint.id,
        success: false,
        statusCode,
        latencyMs: Date.now() - startedAt,
        error: errorMessage,
      };
    }
  }

  async bulkTest(userId: string) {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { userId, active: true },
    });

    const results = await Promise.all(
      endpoints.map((ep) => this.sendTestPing(ep)),
    );

    return { tested: results.length, results };
  }

  // ── Auto-retry scheduler ───────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE, { name: 'webhook-retry-queue' })
  async processRetryQueue() {
    const due = await this.prisma.webhookDelivery.findMany({
      where: {
        nextRetryAt: { lte: new Date() },
        permanentlyFailedAt: null,
        deliveredAt: null,
      },
      include: { endpoint: true },
      take: 50,
    });

    if (due.length === 0) return;

    this.logger.debug(`[retry-queue] Processing ${due.length} due deliveries`);

    await Promise.allSettled(
      due.map((delivery) => this.executeRetry(delivery.endpoint, delivery)),
    );
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private async deliverOnce(
    ep: EndpointWithOptionalEncryptedHeaders,
    eventType: string,
    payload: unknown,
  ) {
    const payloadCheck = this.preparePayloadForDelivery(eventType, payload);
    const body = payloadCheck.body;
    const ts = nowUnixSeconds();
    const signature = signBody(ep.secret, body);
    const signatureV2 = signBodyV2(ep.secret, ts, body);

    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        endpointId: ep.id,
        eventType,
        payload: payload as Prisma.InputJsonValue,
        attemptCount: 1,
      },
    });

    const startedAt = Date.now();
    if (payloadCheck.exceedsLimit) {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          statusCode: null,
          responseBody: `Payload exceeds max size (${payloadCheck.bytes}/${this.maxPayloadBytes} bytes)`,
          nextRetryAt: null,
          permanentlyFailedAt: new Date(),
        },
      });
      this.recordDeliveryMetric(startedAt, null);

      this.logger.warn(
        `[webhook] Delivery ${delivery.id} not sent for endpoint ${ep.id}: payload exceeds configured max of ${this.maxPayloadBytes} bytes`,
      );
      return;
    }

    try {
      const res = await postGuarded(ep.url, body, {
        headers: {
          "Content-Type": "application/json",
          "X-ChainSettle-Timestamp": String(ts),
          "X-ChainSettle-Signature": signature,
          "X-ChainSettle-Signature-V2": signatureV2,
        },
        timeout: this.deliveryTimeoutMs,
      });

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          statusCode: res.status,
          responseBody: String(res.data ?? "").slice(0, 1_000),
          deliveredAt: new Date(),
          nextRetryAt: null,
        },
      });
      this.recordDeliveryMetric(startedAt, res.status);
    } catch (err) {
      this.recordDeliveryMetric(startedAt, (err as AxiosError).response?.status ?? null);
      await this.handleFailure(
        delivery,
        ep.secret,
        ep.url,
        err as AxiosError | Error,
      );
    }
  }

  private async executeRetry(
    ep: EndpointWithOptionalEncryptedHeaders,
    delivery: {
      id: string;
      eventType: string;
      payload: unknown;
      attemptCount: number;
    },
  ) {
    const payloadCheck = this.preparePayloadForDelivery(
      delivery.eventType,
      delivery.payload as Record<string, unknown>,
    );
    const body = payloadCheck.body;
    const ts = nowUnixSeconds();
    const signature = signBody(ep.secret, body);
    const signatureV2 = signBodyV2(ep.secret, ts, body);

    const updatedDelivery = await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attemptCount: delivery.attemptCount + 1,
        nextRetryAt: null,
      },
    });

    const startedAt = Date.now();
    if (payloadCheck.exceedsLimit) {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          statusCode: null,
          responseBody: `Payload exceeds max size (${payloadCheck.bytes}/${this.maxPayloadBytes} bytes)`,
          nextRetryAt: null,
          permanentlyFailedAt: new Date(),
        },
      });
      this.recordDeliveryMetric(startedAt, null);

      this.logger.warn(
        `[webhook] Retry ${delivery.id} skipped for endpoint ${ep.id}: payload exceeds configured max of ${this.maxPayloadBytes} bytes`,
      );
      return;
    }

    try {
      const res = await postGuarded(ep.url, body, {
        headers: {
          "Content-Type": "application/json",
          "X-ChainSettle-Timestamp": String(ts),
          "X-ChainSettle-Signature": signature,
          "X-ChainSettle-Signature-V2": signatureV2,
        },
        timeout: this.deliveryTimeoutMs,
      });

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          statusCode: res.status,
          responseBody: String(res.data ?? "").slice(0, 1_000),
          deliveredAt: new Date(),
          nextRetryAt: null,
          permanentlyFailedAt: null,
        },
      });
      this.recordDeliveryMetric(startedAt, res.status);

      this.logger.log(
        `[retry] Delivery ${delivery.id} succeeded on attempt ${updatedDelivery.attemptCount}`,
      );
    } catch (err) {
      this.recordDeliveryMetric(startedAt, (err as AxiosError).response?.status ?? null);
      await this.handleFailure(
        updatedDelivery,
        ep.secret,
        ep.url,
        err as AxiosError | Error,
      );
    }
  }

  private async handleFailure(
    delivery: { id: string; attemptCount: number },
    _secret: string,
    _url: string,
    err: AxiosError | Error,
  ) {
    const statusCode: number | null =
      (err as AxiosError).response?.status ?? null;
    const responseBody = String(
      (err as AxiosError).response?.data ?? (err as Error).message ?? "",
    ).slice(0, 1_000);

    const retryable = isRetryable(err);
    const exhausted = delivery.attemptCount >= MAX_AUTO_ATTEMPTS;

    if (retryable && !exhausted) {
      const nextRetryAt = nextRetryDate(delivery.attemptCount);

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          statusCode,
          responseBody,
          nextRetryAt,
          permanentlyFailedAt: null,
        },
      });

      this.logger.warn(
        `[retry] Delivery ${delivery.id} failed (attempt ${delivery.attemptCount}/${MAX_AUTO_ATTEMPTS}). ` +
          `Next retry at ${nextRetryAt.toISOString()}`,
      );
    } else {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          statusCode,
          responseBody,
          nextRetryAt: null,
          permanentlyFailedAt: new Date(),
        },
      });

      const reason = !retryable
        ? `non-retryable status ${statusCode}`
        : `max attempts (${MAX_AUTO_ATTEMPTS}) exhausted`;

      this.logger.warn(
        `[retry] Delivery ${delivery.id} permanently failed — ${reason}`,
      );
    }
  }

  private describeRetryStatus(delivery: {
    deliveredAt: Date | null;
    permanentlyFailedAt: Date | null;
    nextRetryAt: Date | null;
    attemptCount: number;
  }): {
    state: "succeeded" | "pending_retry" | "permanently_failed" | "pending";
    nextRetryAt: Date | null;
    attemptCount: number;
  } {
    if (delivery.deliveredAt) {
      return {
        state: "succeeded",
        nextRetryAt: null,
        attemptCount: delivery.attemptCount,
      };
    }
    if (delivery.permanentlyFailedAt) {
      return {
        state: "permanently_failed",
        nextRetryAt: null,
        attemptCount: delivery.attemptCount,
      };
    }
    if (delivery.nextRetryAt) {
      return {
        state: "pending_retry",
        nextRetryAt: delivery.nextRetryAt,
        attemptCount: delivery.attemptCount,
      };
    }
    return {
      state: "pending",
      nextRetryAt: null,
      attemptCount: delivery.attemptCount,
    };
  }
}
