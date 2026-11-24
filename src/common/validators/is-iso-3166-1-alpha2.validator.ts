import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

/**
 * Validates that a string is a valid ISO 3166-1 alpha-2 country code
 * (two uppercase ASCII letters, e.g. "US", "DE", "GB").
 *
 * The check is purely structural — it does not verify the code is
 * currently assigned by ISO, but rejects anything that is not exactly
 * two ASCII letters, catching obvious typos (e.g. "USA", "us", "12").
 */
export function IsISO31661Alpha2(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isISO31661Alpha2',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          if (typeof value !== 'string') return false;
          return /^[A-Z]{2}$/.test(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid ISO 3166-1 alpha-2 country code (e.g., "US", "DE")`;
        },
      },
    });
  };
}
