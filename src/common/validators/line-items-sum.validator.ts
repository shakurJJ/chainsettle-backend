import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';

/**
 * Validates that the sum of (quantity × unitPrice) across all line items
 * does not exceed the shipment's totalAmount (expressed in human-readable
 * token units, i.e. stroops ÷ 10^decimals — we compare against the
 * human-readable totalAmount string the DTO carries).
 *
 * Applied to the `lineItems` array field; reads `totalAmount` from the
 * parent object via ValidationArguments.object.
 */
@ValidatorConstraint({ name: 'lineItemsSum', async: false })
export class LineItemsSumConstraint implements ValidatorConstraintInterface {
  validate(lineItems: any[], args: ValidationArguments): boolean {
    if (!Array.isArray(lineItems) || lineItems.length === 0) return true;

    const parent = args.object as any;

    // totalAmount on the DTO is a string in stroops (smallest unit, 7 decimals).
    // Convert to human-readable by dividing by 10^7 for comparison.
    const totalAmountRaw = parent?.totalAmount;
    if (!totalAmountRaw) return true; // let the @IsNotEmpty on totalAmount catch it

    let totalHuman: number;
    try {
      totalHuman = Number(BigInt(totalAmountRaw)) / 1e7;
    } catch {
      return true; // malformed totalAmount — let the other validators catch it
    }

    const lineItemsSum = lineItems.reduce((acc, item) => {
      const qty = Number(item?.quantity ?? 0);
      const price = parseFloat(item?.unitPrice ?? '0');
      return acc + qty * price;
    }, 0);

    return lineItemsSum <= totalHuman;
  }

  defaultMessage(args: ValidationArguments): string {
    const parent = args.object as any;
    let totalHuman = 0;
    try {
      totalHuman = Number(BigInt(parent?.totalAmount ?? '0')) / 1e7;
    } catch {
      // ignore
    }

    const lineItems: any[] = Array.isArray(args.value) ? args.value : [];
    const lineItemsSum = lineItems.reduce((acc, item) => {
      const qty = Number(item?.quantity ?? 0);
      const price = parseFloat(item?.unitPrice ?? '0');
      return acc + qty * price;
    }, 0);

    return (
      `The sum of line item values (quantity × unitPrice = ${lineItemsSum.toFixed(6)}) ` +
      `must not exceed the shipment totalAmount (${totalHuman.toFixed(6)}).`
    );
  }
}

export function IsLineItemsSumValid(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: LineItemsSumConstraint,
    });
  };
}
