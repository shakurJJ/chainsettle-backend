import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateTemplateFromShipmentDto {
  @ApiProperty({ example: 'Standard China Import' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ required: false, example: 'Derived from shipment SHIP-001' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, default: false, description: 'Whether template is visible to all users' })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}
