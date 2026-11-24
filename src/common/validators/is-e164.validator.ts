import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

/**
 * Validator that checks if a string is in E.164 format.
 * E.164 format: + followed by 1-15 digits, no spaces or special characters.
 * Example: +14155551234, +442071838750
 */
export function IsE164(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isE164',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          if (typeof value !== 'string') return false;
          // E.164: starts with +, followed by 1-15 digits
          return /^\+[1-9]\d{1,14}$/.test(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid E.164 phone number (e.g., +14155551234)`;
        },
      },
    });
  };
}