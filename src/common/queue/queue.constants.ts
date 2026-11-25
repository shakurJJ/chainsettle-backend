import { NotificationType } from '@prisma/client';

/**
 * BullMQ queue names. Defined in one place so producers, workers, the metrics
 * collector and the admin view all agree on the set of background queues (#661).
 */
export const QUEUE_WEBHOOKS = 'webhooks' as const;
export const QUEUE_EMAILS = 'emails' as const;
export const QUEUE_EXPORTS = 'exports' as const;

export type QueueName =
  typeof QUEUE_WEBHOOKS | typeof QUEUE_EMAILS | typeof QUEUE_EXPORTS;

export const QUEUE_NAMES: readonly QueueName[] = [
  QUEUE_WEBHOOKS,
  QUEUE_EMAILS,
  QUEUE_EXPORTS,
];

export function isQueueName(value: string): value is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(value);
}

/** Job names within each queue. */
export const JOB_WEBHOOK_DELIVERY = 'webhook-delivery';
export const JOB_SEND_EMAIL = 'send-email';
export const JOB_SHIPMENTS_EXPORT = 'shipments-export';

// ─── Job payloads ────────────────────────────────────────────────────────────

export interface WebhookDeliveryJobData {
  deliveryId: string;
}

export interface SendEmailJobData {
  to: string;
  subject: string;
  text: string;
  html?: string;
  type?: NotificationType;
  data?: Record<string, any>;
  locale?: string;
  userId?: string;
}

export type ShipmentsExportFormat = 'csv' | 'pdf';

export interface ShipmentsExportJobData {
  userId: string;
  stellarAddress: string;
  isAdmin: boolean;
  format: ShipmentsExportFormat;
}

export interface ShipmentsExportResult {
  format: ShipmentsExportFormat;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/** Redis key holding a finished export, keyed by BullMQ job id. */
export function exportResultKey(jobId: string): string {
  return `chainsettle:exports:${jobId}`;
}
