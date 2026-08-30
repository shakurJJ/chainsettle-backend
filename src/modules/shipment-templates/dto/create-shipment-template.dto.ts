import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  Max,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsStellarAddress } from '../../../common/decorators/is-stellar-address.decorator';

export class MilestoneTemplateDto {
  @ApiProperty({ example: 'Goods Dispatched' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 25, description: 'Payment percentage' })
  @IsInt()
  @Min(1)
  @Max(100)
  paymentPercent: number;

  @ApiProperty({ required: false, example: 7, description: 'Days until due (optional)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  dueDays?: number;
}

export class CreateShipmentTemplateDto {
  @ApiProperty({ example: 'Standard China Import' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ required: false, example: 'Standard 3-milestone template for China imports' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, example: 'GABC...supplier' })
  @IsOptional()
  @IsStellarAddress()
  supplierAddress?: string;

  @ApiProperty({ required: false, example: 'GABC...logistics' })
  @IsOptional()
  @IsStellarAddress()
  logisticsAddress?: string;

  @ApiProperty({ required: false, example: 'GABC...arbiter' })
  @IsOptional()
  @IsStellarAddress()
  arbiterAddress?: string;

  @ApiProperty({ required: false, example: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA' })
  @IsOptional()
  @IsString()
  tokenAddress?: string;

  @ApiProperty({ type: [MilestoneTemplateDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MilestoneTemplateDto)
  milestoneTemplates: MilestoneTemplateDto[];

  @ApiProperty({ required: false, default: false, description: 'Whether template is visible to all users' })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class UpdateShipmentTemplateDto {
  @ApiProperty({ required: false, example: 'Standard China Import' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false, example: 'Standard 3-milestone template for China imports' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, example: 'GABC...supplier' })
  @IsOptional()
  @IsStellarAddress()
  supplierAddress?: string;

  @ApiProperty({ required: false, example: 'GABC...logistics' })
  @IsOptional()
  @IsStellarAddress()
  logisticsAddress?: string;

  @ApiProperty({ required: false, example: 'GABC...arbiter' })
  @IsOptional()
  @IsStellarAddress()
  arbiterAddress?: string;

  @ApiProperty({ required: false, example: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA' })
  @IsOptional()
  @IsString()
  tokenAddress?: string;

  @ApiProperty({ required: false, type: [MilestoneTemplateDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MilestoneTemplateDto)
  milestoneTemplates?: MilestoneTemplateDto[];

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class UpdateTemplateVisibilityDto {
  @ApiProperty({ example: true, description: 'Whether the template should be visible to all users' })
  @IsBoolean()
  isPublic: boolean;
}
