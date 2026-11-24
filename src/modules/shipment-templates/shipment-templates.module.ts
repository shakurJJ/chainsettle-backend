import { Module } from '@nestjs/common';
import { ShipmentTemplatesController } from './shipment-templates.controller';
import { ShipmentTemplatesService } from './shipment-templates.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [AuditLogsModule],
  controllers: [ShipmentTemplatesController],
  providers: [ShipmentTemplatesService],
  exports: [ShipmentTemplatesService],
})
export class ShipmentTemplatesModule {}
