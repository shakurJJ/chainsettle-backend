import { Body, Controller, HttpCode, HttpStatus, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TransactionBuilderService } from '../../common/stellar/transaction-builder.service';
import { RaiseDisputePrepareDto } from './dto/raise-dispute-prepare.dto';

/**
 * Unsigned transaction builders: return simulated, resource-assembled XDR
 * for the caller's wallet to sign and submit (e.g. via POST /chain/submit).
 */
@ApiTags('chain')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('shipments')
export class TransactionPrepareController {
  constructor(private readonly builder: TransactionBuilderService) {}

  @Post(':shipmentId/milestones/:index/confirm/prepare')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Build unsigned confirm_milestone transaction (buyer only)' })
  @ApiResponse({ status: 422, description: 'Simulation failed' })
  confirm(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
    @CurrentUser('stellarAddress') caller: string,
  ) {
    return this.builder.prepareConfirmMilestone(shipmentId, index, caller);
  }

  @Post(':shipmentId/milestones/:index/dispute/prepare')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Build unsigned raise_dispute transaction (buyer or supplier)' })
  @ApiResponse({ status: 422, description: 'Simulation failed' })
  dispute(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: RaiseDisputePrepareDto,
    @CurrentUser('stellarAddress') caller: string,
  ) {
    return this.builder.prepareRaiseDispute(shipmentId, index, caller, dto.reason);
  }

  @Post(':shipmentId/cancel/prepare')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Build unsigned cancel_shipment transaction (buyer only)' })
  @ApiResponse({ status: 422, description: 'Simulation failed' })
  cancel(@Param('shipmentId') shipmentId: string, @CurrentUser('stellarAddress') caller: string) {
    return this.builder.prepareCancelShipment(shipmentId, caller);
  }
}
