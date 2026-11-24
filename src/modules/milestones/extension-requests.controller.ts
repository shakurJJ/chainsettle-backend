import {
  Controller,
  Get,
  Post,
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
import { ExtensionRequestsService } from './extension-requests.service';
import { CreateExtensionRequestDto, DecideExtensionRequestDto } from './dto/extension-request.dto';

@ApiTags('milestones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ShipmentParticipantGuard)
@Controller('shipments/:shipmentId/milestones/:index/extension-requests')
export class ExtensionRequestsController {
  constructor(private readonly extensions: ExtensionRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'Full deadline extension request history for a milestone (newest first)' })
  list(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.extensions.list(shipmentId, index);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request a later dueAt (supplier/logistics only)' })
  @ApiResponse({ status: 403, description: 'Caller is not the supplier or logistics provider' })
  @ApiResponse({ status: 409, description: 'A pending request already exists for this milestone' })
  create(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: CreateExtensionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.extensions.create(shipmentId, index, dto, user?.stellarAddress ?? user?.sub, user?.id);
  }

  @Post(':requestId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve an extension request (buyer only); updates dueAt and resets overdue reminders' })
  approve(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
    @Param('requestId') requestId: string,
    @Body() dto: DecideExtensionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.extensions.approve(shipmentId, index, requestId, dto, user?.stellarAddress ?? user?.sub, user?.id);
  }

  @Post(':requestId/deny')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deny an extension request (buyer only); dueAt is unchanged' })
  deny(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
    @Param('requestId') requestId: string,
    @Body() dto: DecideExtensionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.extensions.deny(shipmentId, index, requestId, dto, user?.stellarAddress ?? user?.sub, user?.id);
  }
}
