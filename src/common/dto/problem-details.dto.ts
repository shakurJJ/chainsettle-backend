import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** RFC 9457 problem details body returned for every error (application/problem+json). */
export class ProblemDetailsDto {
  @ApiProperty({ example: 'https://chainsettle.dev/problems/not-found' })
  type!: string;

  @ApiProperty({ example: 'Not Found' })
  title!: string;

  @ApiProperty({ example: 404 })
  status!: number;

  @ApiProperty({ example: 'Shipment not found' })
  detail!: string;

  @ApiProperty({ example: '/api/v1/shipments/abc' })
  instance!: string;

  @ApiProperty({ example: 'NOT_FOUND', description: 'Stable machine-readable error code' })
  code!: string;

  @ApiPropertyOptional({ deprecated: true, example: false })
  success?: boolean;

  @ApiPropertyOptional({ deprecated: true, example: 404 })
  statusCode?: number;

  @ApiPropertyOptional({ deprecated: true })
  timestamp?: string;

  @ApiPropertyOptional({ deprecated: true })
  path?: string;

  @ApiPropertyOptional({ deprecated: true, description: 'Legacy message (string or validation array)' })
  message?: unknown;
}
