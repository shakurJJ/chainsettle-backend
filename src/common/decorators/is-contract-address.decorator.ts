import { registerDecorator, ValidationOptions, ValidationArguments } from 'class-validator';
import { StrKey } from '@stellar/stellar-sdk';

/**
 * Validates a Soroban contract address (StrKey "C..." format).
 * Distinct from IsStellarAddress, which validates Ed25519 account keys
 * ("G..."). Token registry entries are contract addresses, not accounts.
 */
export function IsContractAddress(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isContractAddress',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          return typeof value === 'string' && StrKey.isValidContract(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid Stellar contract address`;
        },
      },
    });
  };
}