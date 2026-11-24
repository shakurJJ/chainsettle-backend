import { Global, Module } from '@nestjs/common';
import { StellarService } from './stellar.service';
import { TransactionBuilderService } from './transaction-builder.service';

@Global()
@Module({
  providers: [StellarService, TransactionBuilderService],
  exports: [StellarService, TransactionBuilderService],
})
export class StellarModule {}
