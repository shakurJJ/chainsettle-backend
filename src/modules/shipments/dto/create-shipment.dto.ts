import {
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsISO8601,
  MaxLength,
  IsObject,
  IsNumberString,
  IsPositive,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsMilestoneSumValid } from '../../../common/validators/milestone-sum.validator';
import { IsLineItemsSumValid } from '../../../common/validators/line-items-sum.validator';
import { IsStellarAddress } from '../../../common/decorators/is-stellar-address.decorator';

export class LineItemDto {
  @ApiProperty({ required: false, example: 'SKU-1234', description: 'Stock-keeping unit code (optional)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string;

  @ApiProperty({ example: 'Industrial Pump', description: 'Human-readable product name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 10, description: 'Quantity (supports decimals, e.g. 1.5 kg)' })
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @IsPositive()
  quantity: number;

  @ApiProperty({ required: false, example: 'pcs', description: 'Unit of measure (default: unit)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  @ApiProperty({ example: '500.00', description: 'Price per unit in human-readable token amount (not stroops)' })
  @IsNumberString()
  unitPrice: string;

  @ApiProperty({ required: false, example: 'USDC', description: 'Currency / token symbol (default: USDC)' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;
}

export class MilestoneDto {
  @ApiProperty({ example: 'Goods Dispatched' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 25, description: 'Payment percentage (all must sum to 100)' })
  @IsInt()
  @Min(1)
  @Max(100)
  paymentPercent: number;

  @ApiProperty({ required: false, example: '2026-06-30T23:59:59Z', description: 'Optional milestone deadline (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  dueAt?: string;
}

export class CreateShipmentDto {
  @ApiProperty({ example: 'SHIP-2026-001' })
  @IsString()
  @IsNotEmpty()
  shipmentId: string;

  @ApiProperty({ required: false, example: 'template-uuid', description: 'Optional template ID to pre-populate from' })
  @IsOptional()
  @IsString()
  templateId?: string;

  @ApiProperty({ example: 'GABC...buyer' })
  @IsStellarAddress()
  @IsNotEmpty()
  buyerAddress: string;

  @ApiProperty({ example: 'GABC...supplier', required: false })
  @IsOptional()
  @IsStellarAddress()
  supplierAddress?: string;

  @ApiProperty({ example: 'GABC...logistics', required: false })
  @IsOptional()
  @IsStellarAddress()
  logisticsAddress?: string;

  @ApiProperty({ example: 'GABC...arbiter', required: false })
  @IsOptional()
  @IsStellarAddress()
  arbiterAddress?: string;

  @ApiProperty({ example: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', required: false })
  @IsOptional()
  @IsString()
  tokenAddress?: string;

  @ApiProperty({ type: [MilestoneDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MilestoneDto)
  @IsMilestoneSumValid() // <-- The new cross-field validation is applied here
  milestones?: MilestoneDto[];

  @ApiProperty({ example: '1000000000', description: 'Total USDC in stroops (7 decimal places)' })
  @IsString()
  @IsNotEmpty()
  totalAmount: string;

  @ApiProperty({ required: false, description: 'On-chain transaction hash of the create_shipment call' })
  @IsOptional()
  @IsString()
  txHash?: string;

  @ApiProperty({ required: false, example: 'Electronics shipment from China', description: 'Human-readable description of shipment contents (max 1000 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ required: false, example: 'PO-2026-001', description: 'Contract/PO reference number (must be unique)' })
  @IsOptional()
  @IsString()
  referenceNumber?: string;

  @ApiProperty({ required: false, example: { incoterms: 'FOB', portOfLoading: 'Lagos' }, description: 'Arbitrary key-value metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiProperty({ required: false, example: ['urgent', 'fragile'], description: 'Searchable tags' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ required: false, example: '2026-07-01T00:00:00.000Z', description: 'Promised delivery date/time (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  expectedDeliveryAt?: string;

  @ApiProperty({
    required: false,
    example: 2,
    description:
      'Co-approvals required before any milestone may be confirmed. Only accepted ' +
      'for shipments at or above MULTISIG_VALUE_THRESHOLD_STROOPS; omit for smaller ' +
      'shipments, which use the single-approver flow.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  requiredApprovals?: number;

  @ApiProperty({
    type: [LineItemDto],
    required: false,
    description:
      'Structured list of goods in this shipment. The sum of (quantity × unitPrice) ' +
      'across all items must not exceed totalAmount (converted to human-readable units).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  @IsLineItemsSumValid()
  lineItems?: LineItemDto[];
}

export class ApproveShipmentDto {
  @ApiProperty({
    required: false,
    example: 'Reviewed against PO-2026-001 and approved by finance.',
    description: 'Optional note recorded alongside the approval',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CancelShipmentDto {
  @ApiProperty({ example: 'abc123...', description: 'On-chain transaction hash of the cancel call' })
  @IsString()
  @IsNotEmpty()
  txHash: string;
}

export class UpdateShipmentDto {
  @ApiProperty({ required: false, example: 'Electronics shipment from China', description: 'Human-readable description (max 1000 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ required: false, example: 'PO-2026-001', description: 'Contract/PO reference number (must be unique)' })
  @IsOptional()
  @IsString()
  referenceNumber?: string;

  @ApiProperty({ required: false, example: { incoterms: 'FOB', portOfLoading: 'Lagos' }, description: 'Arbitrary key-value metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiProperty({ required: false, example: ['urgent', 'fragile'], description: 'Searchable tags' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ required: false, example: '2026-07-01T00:00:00.000Z', description: 'Promised delivery date/time (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  expectedDeliveryAt?: string;

  @ApiProperty({
    type: [LineItemDto],
    required: false,
    description:
      'Replace all line items for this shipment. Only accepted while the shipment is DRAFT. ' +
      'The sum of (quantity × unitPrice) must not exceed totalAmount.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  lineItems?: LineItemDto[];
}

export class BulkStatusDto {
  @ApiProperty({ type: [String], example: ['SHIP-001', 'SHIP-002'], description: 'Shipment IDs to look up (1–50 items)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  ids: string[];
}

export class CloneShipmentDto {
  @ApiProperty({ example: 'abc123...txhash', description: 'On-chain transaction hash for the new cloned shipment' })
  @IsString()
  @IsNotEmpty()
  txHash: string;

  @ApiProperty({ example: '1000000000', description: 'Total amount in stroops for the new shipment (7 decimal places)' })
  @IsString()
  @IsNotEmpty()
  totalAmount: string;
}