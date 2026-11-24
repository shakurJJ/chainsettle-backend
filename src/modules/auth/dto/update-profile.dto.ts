import {
  IsOptional,
  IsString,
  IsEmail,
  MaxLength,
  IsIn,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { SUPPORTED_CURRENCIES } from "../../../common/fx/fx-rate.service";
import { SUPPORTED_LOCALES } from "../../../i18n/i18n.service";

export class UpdateProfileDto {
  @ApiPropertyOptional({
    example: "John Doe",
    description: "User display name",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    example: "john@example.com",
    description: "User email address",
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    example: "EUR",
    description:
      "Preferred display currency for converted shipment values. " +
      `Supported: ${SUPPORTED_CURRENCIES.join(", ")}. Defaults to USD.`,
    enum: SUPPORTED_CURRENCIES,
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.toUpperCase() : value,
  )
  @IsIn([...SUPPORTED_CURRENCIES], {
    message: `displayCurrency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`,
  })
  displayCurrency?: string;

  @ApiPropertyOptional({
    example: "es",
    description:
      "Preferred language locale for notifications and emails. " +
      `Supported: ${SUPPORTED_LOCALES.join(", ")}. Defaults to en.`,
    enum: SUPPORTED_LOCALES,
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.toLowerCase() : value,
  )
  @IsIn([...SUPPORTED_LOCALES], {
    message: `locale must be one of: ${SUPPORTED_LOCALES.join(", ")}`,
  })
  locale?: string;
}
