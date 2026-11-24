import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Represents a single Shipment as returned by the API.
 *
 * IMPORTANT – bigint serialisation:
 *   JSON.stringify cannot handle BigInt natively.  Fields that map to Solidity
 *   uint256 values (totalAmount, releasedAmount, paymentReleased) are stored as
 *   bigint in the database but MUST be converted to string before being sent
 *   over the wire.  The @ApiProperty({ type: String }) annotation tells Swagger
 *   to emit `"type": "string"` in the schema instead of "integer" or "object".
 */
export class ShipmentResponseDto {
  @ApiProperty({
    description: 'Unique shipment identifier (UUID)',
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  })
  id: string;

  @ApiProperty({
    description: 'Human-readable shipment reference number',
    example: 'SHP-2024-00123',
  })
  shipmentNumber: string;

  @ApiProperty({
    description: 'Current lifecycle status of the shipment',
    example: 'IN_TRANSIT',
    enum: ['CREATED', 'IN_TRANSIT', 'CUSTOMS', 'DELIVERED', 'CANCELLED'],
  })
  status: string;

  @ApiProperty({
    description: 'Origin location / port of loading',
    example: 'Shanghai, CN',
  })
  origin: string;

  @ApiProperty({
    description: 'Destination location / port of discharge',
    example: 'Rotterdam, NL',
  })
  destination: string;

  @ApiPropertyOptional({
    description: 'Ethereum address of the escrow smart contract',
    example: '0x1234567890abcdef1234567890abcdef12345678',
  })
  contractAddress?: string;

  /**
   * bigint → string
   * Total escrow amount in the smallest unit of the payment token (e.g. wei).
   * Serialised as string because JSON cannot represent BigInt.
   */
  @ApiProperty({
    type: String,
    description:
      'Total escrow amount (wei / token smallest unit). Serialised as string due to BigInt size.',
    example: '1000000000000000000',
  })
  totalAmount: string;

  /**
   * bigint → string
   * Cumulative amount released from escrow so far.
   */
  @ApiProperty({
    type: String,
    description: 'Cumulative amount released from escrow (wei). Serialised as string.',
    example: '250000000000000000',
  })
  releasedAmount: string;

  /**
   * bigint → string
   * Total payment released on final delivery confirmation.
   */
  @ApiProperty({
    type: String,
    description: 'Payment released on delivery confirmation (wei). Serialised as string.',
    example: '0',
  })
  paymentReleased: string;

  @ApiProperty({
    description: 'ISO-8601 timestamp of shipment creation',
    example: '2024-01-15T08:30:00.000Z',
  })
  createdAt: string;

  @ApiProperty({
    description: 'ISO-8601 timestamp of last update',
    example: '2024-03-22T14:00:00.000Z',
  })
  updatedAt: string;

  @ApiPropertyOptional({
    description: 'ISO-8601 estimated time of arrival',
    example: '2024-04-01T00:00:00.000Z',
  })
  estimatedArrival?: string;

  @ApiPropertyOptional({
    description: 'ISO-8601 promised delivery date/time',
    example: '2024-04-05T00:00:00.000Z',
  })
  expectedDeliveryAt?: string;

  @ApiPropertyOptional({
    description: 'Wallet address of the shipper',
    example: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  })
  shipperAddress?: string;

  @ApiPropertyOptional({
    description: 'Wallet address of the consignee',
    example: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  })
  consigneeAddress?: string;
}