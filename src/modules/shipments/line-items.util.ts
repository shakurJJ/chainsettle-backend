import { BadRequestException } from '@nestjs/common';

const DECIMAL_PLACES = 6;
const LINE_ITEM_TOTAL_SCALE = 12;
const DECIMAL_SCALE = 1_000_000n;

function toScaledDecimal(value: number | string, field: string): bigint {
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(String(value));
  if (!match) {
    throw new BadRequestException(
      `${field} must have at most 12 integer digits and 6 decimal places`,
    );
  }

  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(DECIMAL_PLACES, '0') || '0');
  return whole * DECIMAL_SCALE + fraction;
}

/**
 * Compares line-item totals (quantity and unit price are each Decimal(18, 6))
 * against the shipment amount without rounding or floating-point arithmetic.
 */
export function lineItemsExceedTotalAmount(
  lineItems: readonly { quantity: number; unitPrice: string }[],
  totalAmount: bigint,
  tokenDecimals: number,
): boolean {
  if (!Number.isSafeInteger(tokenDecimals) || tokenDecimals < 0) {
    throw new BadRequestException('Shipment token decimals are invalid');
  }

  const lineItemsTotal = lineItems.reduce((sum, item) => {
    const quantity = toScaledDecimal(item.quantity, 'Line item quantity');
    const unitPrice = toScaledDecimal(item.unitPrice, 'Line item unitPrice');
    return sum + quantity * unitPrice;
  }, 0n);

  return (
    lineItemsTotal * 10n ** BigInt(tokenDecimals) >
    BigInt(totalAmount) * 10n ** BigInt(LINE_ITEM_TOTAL_SCALE)
  );
}
