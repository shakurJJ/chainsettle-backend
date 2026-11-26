import { BadRequestException } from '@nestjs/common';
import { lineItemsExceedTotalAmount } from './line-items.util';

describe('lineItemsExceedTotalAmount', () => {
  it('accepts a line-item total equal to the shipment amount', () => {
    expect(
      lineItemsExceedTotalAmount(
        [{ quantity: 1.5, unitPrice: '2.5' }],
        3_750_000n,
        6,
      ),
    ).toBe(false);
  });

  it('rejects a tiny excess below one token subunit', () => {
    expect(
      lineItemsExceedTotalAmount(
        [{ quantity: 0.000001, unitPrice: '1.000001' }],
        10n,
        7,
      ),
    ).toBe(true);
  });

  it('rejects values that cannot fit the database decimal precision', () => {
    expect(() =>
      lineItemsExceedTotalAmount(
        [{ quantity: 1, unitPrice: '1.0000001' }],
        100_000_000n,
        7,
      ),
    ).toThrow(BadRequestException);
  });
});
