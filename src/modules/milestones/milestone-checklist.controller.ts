import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ParseIntPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { ShipmentParticipantGuard } from '../shipments/guards/shipment-participant.guard';
import { MilestoneChecklistService } from './milestone-checklist.service';
import { CreateChecklistItemDto, UpdateChecklistItemDto } from './dto/checklist.dto';

@ApiTags('milestones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ShipmentParticipantGuard)
@Controller('shipments/:shipmentId/milestones/:index/checklist')
export class MilestoneChecklistController {
  constructor(private readonly checklist: MilestoneChecklistService) {}

  @Get()
  @ApiOperation({ summary: 'List checklist items and completion progress for a milestone' })
  @ApiResponse({ status: 200, description: 'Items plus progress counts' })
  list(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.checklist.list(shipmentId, index);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a checklist item (buyer only, milestone must be PENDING)' })
  @ApiResponse({ status: 403, description: 'Caller is not the buyer' })
  @ApiResponse({ status: 409, description: 'Milestone is not PENDING' })
  create(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: CreateChecklistItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.checklist.create(shipmentId, index, dto, user?.stellarAddress ?? user?.sub, user?.id);
  }

  @Patch(':itemId')
  @ApiOperation({ summary: 'Mark a checklist item complete or reopen it (supplier/logistics only)' })
  @ApiResponse({ status: 403, description: 'Caller is not the supplier or logistics provider' })
  update(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateChecklistItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.checklist.update(shipmentId, index, itemId, dto, user?.stellarAddress ?? user?.sub, user?.id);
  }

  @Delete(':itemId')
  @ApiOperation({ summary: 'Remove a checklist item (buyer only, milestone must be PENDING)' })
  remove(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.checklist.remove(shipmentId, index, itemId, user?.stellarAddress ?? user?.sub, user?.id);
  }
}
