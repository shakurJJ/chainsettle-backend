import { Global, Module } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { OrganizationApiKeysController } from './organization-api-keys.controller';

// Global so shipment guards/services can resolve org access without import cycles.
@Global()
@Module({
  controllers: [OrganizationsController, OrganizationApiKeysController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
