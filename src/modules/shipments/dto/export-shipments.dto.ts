import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ShipmentsExportFormat } from '../../../common/queue/queue.constants';

/** Request body for POST /shipments/export (queued export, #661). */
export class ExportShipmentsDto {
  @ApiPropertyOptional({
    description: 'Export format',
    enum: ['csv', 'pdf'],
    default: 'csv',
  })
  @IsOptional()
  @IsIn(['csv', 'pdf'])
  format?: ShipmentsExportFormat = 'csv';
}
