import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { IsStellarAddress } from "../../../common/decorators/is-stellar-address.decorator";

export class CreateContactDto {
  @ApiProperty({ example: "GABC...supplier" })
  @IsStellarAddress()
  stellarAddress: string;

  @ApiProperty({ example: "Acme Logistics" })
  @IsString()
  @MaxLength(100)
  label: string;

  @ApiPropertyOptional({ enum: UserRole, example: UserRole.SUPPLIER })
  @IsOptional()
  @IsEnum(UserRole)
  defaultRole?: UserRole;

  @ApiPropertyOptional({ example: "Primary contact for west coast shipments" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateContactDto {
  @ApiPropertyOptional({ example: "GABC...supplier" })
  @IsOptional()
  @IsStellarAddress()
  stellarAddress?: string;

  @ApiPropertyOptional({ example: "Acme Logistics" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @ApiPropertyOptional({
    enum: UserRole,
    example: UserRole.SUPPLIER,
    nullable: true,
  })
  @IsOptional()
  @IsEnum(UserRole)
  defaultRole?: UserRole | null;

  @ApiPropertyOptional({
    example: "Primary contact for west coast shipments",
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class SearchContactsDto {
  @ApiPropertyOptional({
    description: "Match labels or Stellar address prefixes",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
