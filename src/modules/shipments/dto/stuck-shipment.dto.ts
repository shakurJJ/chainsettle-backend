import { ApiProperty } from '@nestjs/swagger';

export class StuckShipmentDto {
  @ApiProperty({ description: 'Shipment ID' })
  id: string;

  @ApiProperty({ description: 'Buyer Stellar address' })
  buyerAddress: string;

  @ApiProperty({ description: 'Supplier Stellar address' })
  supplierAddress: string;

  @ApiProperty({ description: 'Timestamp of the last milestone update, or shipment update if none' })
  lastActivityAt: string;

  @ApiProperty({ description: 'Whole days elapsed since lastActivityAt' })
  daysSinceActivity: number;
}
