import { BadRequestException } from '@nestjs/common';

/**
 * Sparse fieldsets for GET /shipments and GET /shipments/:id (#390).
 *
 * Only top-level shipment fields are selectable. `id` is always returned.
 */
export const SHIPMENT_SCALAR_FIELDS = [
  'id',
  'buyerAddress',
  'supplierAddress',
  'logisticsAddress',
  'arbiterAddress',
  'tokenAddress',
  'totalAmount',
  'releasedAmount',
  'status',
  'arbiterStatus',
  'txHash',
  'createdLedger',
  'tokenDecimals',
  'tokenSymbol',
  'description',
  'referenceNumber',
  'metadata',
  'tags',
  'expectedDeliveryAt',
  'cancelledAt',
  'refundTxHash',
  'isDraft',
  'createdAt',
  'updatedAt',
] as const;

export const SHIPMENT_LIST_FIELDS: readonly string[] = [...SHIPMENT_SCALAR_FIELDS, 'milestones'];
export const SHIPMENT_DETAIL_FIELDS: readonly string[] = [
  ...SHIPMENT_LIST_FIELDS,
  'events',
  'trackingUpdates',
  'approvals',
  'lineItems',
];

/**
 * Parse a `fields=a,b,c` query value. Returns undefined when absent/empty
 * (full response). Throws 400 listing valid options on any unknown field.
 * The result always contains `id`, is de-duplicated and sorted so equivalent
 * requests share a cache key.
 */
export function parseFields(raw: string | undefined, allowed: readonly string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  const requested = raw
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  if (requested.length === 0) return undefined;

  const unknown = requested.filter((f) => !allowed.includes(f));
  if (unknown.length > 0) {
    throw new BadRequestException({
      message: `Unknown field(s): ${unknown.join(', ')}`,
      invalidFields: unknown,
      validFields: allowed,
    });
  }
  return Array.from(new Set(['id', ...requested])).sort();
}

/** Keep only the requested keys of an already-serialized shipment. */
export function pickFields<T extends Record<string, any>>(obj: T, fields: string[]): Partial<T> {
  const out: Record<string, any> = {};
  for (const f of fields) {
    if (f in obj) out[f] = obj[f];
  }
  return out as Partial<T>;
}
