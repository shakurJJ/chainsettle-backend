import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

/** Maximum allowed expiry window: 365 days from now. */
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Validates that a date string is no more than 1 year from the current moment.
 * Used alongside @IsFutureDate() on API key expiry dates.
 */
@ValidatorConstraint({ name: 'isAtMostOneYearAhead', async: false })
export class IsAtMostOneYearAheadConstraint implements ValidatorConstraintInterface {
  validate(value: any, _args: ValidationArguments) {
    if (typeof value !== 'string') return false;
    const date = new Date(value);
    if (isNaN(date.getTime())) return false;
    return date.getTime() <= Date.now() + ONE_YEAR_MS;
  }

  defaultMessage(_args: ValidationArguments) {
    return 'expiresAt must be at most 1 year from now';
  }
}

export function IsAtMostOneYearAhead(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsAtMostOneYearAheadConstraint,
    });
  };
}
