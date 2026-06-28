import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ShipmentsService } from './shipments.service';
import { CreateShipmentDto, UpdateShipmentDto, CancelShipmentDto, CloneShipmentDto, BulkStatusDto } from './dto/create-shipment.dto';
import { CreateTrackingDto } from './dto/tracking.dto';
import { FindAllShipmentsDto } from './dto/find-all-shipments.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ShipmentParticipantGuard } from './guards/shipment-participant.guard';
import { UserRole } from '@prisma/client';

@ApiTags('shipments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('shipments')
export class ShipmentsController {
  constructor(private readonly shipmentsService: ShipmentsService) { }

  /**
   * POST /api/v1/shipments
   * Called by the frontend after the buyer has signed and broadcast
   * the create_shipment transaction via Freighter. The backend stores
   * the off-chain metadata and links it to the on-chain shipment.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a newly created on-chain shipment' })
  @ApiResponse({ status: 201, description: 'Shipment registered successfully' })
  create(@Body() dto: CreateShipmentDto, @CurrentUser() user: any) {
    if (user?.role !== UserRole.ADMIN && dto.buyerAddress !== user?.stellarAddress) {
      throw new ForbiddenException('buyerAddress must match the authenticated user');
    }

    return this.shipmentsService.create(dto);
  }

  /**
   * GET /api/v1/shipments
   * List shipments with optional filters and date ranges. Users see only their own shipments.
   */
  @Get()
  @ApiOperation({ summary: 'List shipments with chronological filters and pagination' })
  @ApiResponse({ status: 200, description: 'Filtered list of shipments' })
  findAll(@CurrentUser() user: any, @Query() query: FindAllShipmentsDto) {
    if (query.cursor && query.page) {
      throw new BadRequestException('cursor and page are mutually exclusive');
    }

    if (query.createdAfter && query.createdBefore && new Date(query.createdAfter) > new Date(query.createdBefore)) {
      throw new BadRequestException('createdAfter date cannot be further in the future than createdBefore date');
    }

    if (query.updatedAfter && query.updatedBefore && new Date(query.updatedAfter) > new Date(query.updatedBefore)) {
      throw new BadRequestException('updatedAfter date cannot be further in the future than updatedBefore date');
    }

    const isAdmin = user?.role === UserRole.ADMIN;
    const tags = query.tags ? query.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined;

    return this.shipmentsService.findAll({
      buyerAddress: isAdmin ? query.buyerAddress : undefined,
      supplierAddress: isAdmin ? query.supplierAddress : undefined,
      status: query.status,
      referenceNumber: query.referenceNumber,
      tags,
      page: query.page ? parseInt(query.page) : undefined,
      limit: query.limit ? parseInt(query.limit) : undefined,
      cursor: query.cursor,
      createdAfter: query.createdAfter,
      createdBefore: query.createdBefore,
      updatedAfter: query.updatedAfter,
      updatedBefore: query.updatedBefore,
      callerStellarAddress: user?.stellarAddress,
      isAdmin,
      includeArchived: query.includeArchived,
      search: query.search,
    });
  }

  /**
   * GET /api/v1/shipments/export?format=csv|pdf
   * Export all shipments visible to the caller.
   * Rate-limited to 5 requests per hour per user.
   */
  @Get('export')
  @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } })
  @ApiOperation({ summary: 'Export shipments as CSV or PDF' })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'pdf'], description: 'csv (default) or pdf' })
  async export(
    @CurrentUser() user: any,
    @Query('format') format: string = 'csv',
    @Res() res: Response,
  ) {
    if (!['csv', 'pdf'].includes(format)) {
      throw new BadRequestException('format must be csv or pdf');
    }

    const isAdmin = user?.role === UserRole.ADMIN;
    const shipments = await this.shipmentsService.exportForUser(user.stellarAddress, isAdmin);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (format === 'pdf') {
      const pdf = await this.shipmentsService.buildPdf(shipments);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="chainsettle-export-${timestamp}.pdf"`);
      res.end(pdf);
    } else {
      const csv = this.shipmentsService.buildCsv(shipments);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="chainsettle-export-${timestamp}.csv"`);
      res.end(csv);
    }
  }


  /**
   * POST /api/v1/shipments/bulk-status
   * Returns a map of id → status for up to 50 shipment IDs in a single round trip.
   * IDs the caller is not a participant of are silently omitted.
   */
  @Post('bulk-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get status for multiple shipments by ID (max 50)' })
  @ApiResponse({ status: 200, description: 'Map of shipment id to status' })
  bulkStatus(@Body() dto: BulkStatusDto, @CurrentUser() user: any) {
    const isAdmin = user?.role === UserRole.ADMIN;
    return this.shipmentsService.bulkStatus(dto.ids, user.stellarAddress, isAdmin);
  }

  /**
   * GET /api/v1/shipments/:id/participants
   * Returns all four participant roles with Stellar address and name.
   */
  @Get(':id/participants')
  @UseGuards(ShipmentParticipantGuard)
  @ApiOperation({ summary: 'Get structured list of shipment participants with roles' })
  @ApiResponse({ status: 200, description: 'List of participants' })
  @ApiResponse({ status: 403, description: 'Not a participant' })
  getParticipants(@Param('id') id: string) {
    return this.shipmentsService.getParticipants(id);
  }

  /**
   * GET /api/v1/shipments/:id
   * Full shipment detail including milestones and recent on-chain events.
   */
  @Get(':id')
  @UseGuards(ShipmentParticipantGuard)
  @ApiOperation({ summary: 'Get full shipment details including milestones and events' })
  @ApiResponse({ status: 200, description: 'Shipment found' })
  @ApiResponse({ status: 404, description: 'Shipment not found' })
  findOne(@Param('id') id: string) {
    return this.shipmentsService.findOne(id);
  }

  /**
   * GET /api/v1/shipments/:id/export
   * Export a single shipment as a standalone PDF.
   * Rate-limited to 10 requests per hour per user.
   */
  @Get(':id/export')
  @UseGuards(ShipmentParticipantGuard)
  @Throttle({ default: { limit: 10, ttl: 60 * 60 * 1000 } })
  @ApiOperation({ summary: 'Export a single shipment as a standalone PDF' })
  @ApiResponse({ status: 200, description: 'PDF export generated' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  @ApiResponse({ status: 404, description: 'Shipment not found' })
  async exportOne(@Param('id') id: string, @Res() res: Response) {
    const pdf = await this.shipmentsService.exportOnePdf(id);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="chainsettle-shipment-${id}-${timestamp}.pdf"`);
    res.end(pdf);
  }

  /**
   * PATCH /api/v1/shipments/:id
   * Update shipment metadata (description, referenceNumber, metadata, tags).
   */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update shipment metadata (description, reference, metadata, tags)' })
  @ApiResponse({ status: 200, description: 'Shipment updated successfully' })
  @ApiResponse({ status: 403, description: 'Only buyer can update' })
  @ApiResponse({ status: 409, description: 'Reference number already in use' })
  update(@Param('id') id: string, @Body() dto: UpdateShipmentDto, @CurrentUser() user: any) {
    return this.shipmentsService.update(id, user.stellarAddress, dto);
  }

  /**
   * POST /api/v1/shipments/:id/arbiter/accept
   */
  @Post(':id/arbiter/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept arbiter assignment for a shipment' })
  @ApiResponse({ status: 200, description: 'Arbiter assignment accepted' })
  @ApiResponse({ status: 403, description: 'Only the designated arbiter can accept' })
  @ApiResponse({ status: 409, description: 'Assignment already resolved' })
  arbiterAccept(@Param('id') id: string, @CurrentUser() user: any) {
    return this.shipmentsService.arbiterAccept(id, user.stellarAddress);
  }

  /**
   * POST /api/v1/shipments/:id/arbiter/decline
   */
  @Post(':id/arbiter/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline arbiter assignment for a shipment' })
  @ApiResponse({ status: 200, description: 'Arbiter assignment declined' })
  @ApiResponse({ status: 403, description: 'Only the designated arbiter can decline' })
  @ApiResponse({ status: 409, description: 'Assignment already resolved' })
  arbiterDecline(@Param('id') id: string, @CurrentUser() user: any) {
    return this.shipmentsService.arbiterDecline(id, user.stellarAddress);
  }

  /**
   * POST /api/v1/shipments/:id/clone
   * Copies a shipment's structure into a new ACTIVE shipment with a fresh ID and reset milestones.
   * Restricted to the original shipment's buyerAddress.
   */
  @Post(':id/clone')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Clone a shipment into a new active shipment (buyer only)' })
  @ApiResponse({ status: 201, description: 'Cloned shipment created' })
  @ApiResponse({ status: 403, description: 'Only the original buyer can clone' })
  @ApiResponse({ status: 404, description: 'Source shipment not found' })
  clone(@Param('id') id: string, @Body() dto: CloneShipmentDto, @CurrentUser() user: any) {
    return this.shipmentsService.clone(id, user.stellarAddress, dto);
  }

  /**
   * POST /api/v1/shipments/:id/cancel
   * Buyer registers the on-chain cancellation tx hash, transitioning the shipment to CANCELLED.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a shipment (buyer only)' })
  @ApiResponse({ status: 200, description: 'Shipment cancelled' })
  @ApiResponse({ status: 403, description: 'Only the buyer can cancel' })
  @ApiResponse({ status: 409, description: 'Shipment is not ACTIVE' })
  cancel(@Param('id') id: string, @Body() dto: CancelShipmentDto, @CurrentUser() user: any) {
    return this.shipmentsService.cancel(id, user.stellarAddress, dto.txHash);
  }

  /**
   * POST /api/v1/shipments/:id/archive
   * Archive a completed/cancelled shipment to hide it from default listings (buyer only).
   */
  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a completed/cancelled shipment (buyer only)' })
  @ApiResponse({ status: 200, description: 'Shipment archived' })
  @ApiResponse({ status: 403, description: 'Only the buyer can archive' })
  @ApiResponse({ status: 409, description: 'Only COMPLETED or CANCELLED shipments can be archived' })
  archive(@Param('id') id: string, @CurrentUser() user: any) {
    return this.shipmentsService.archive(id, user.stellarAddress);
  }

  /**
   * POST /api/v1/shipments/:id/unarchive
   * Restore an archived shipment to the default listing (buyer only).
   */
  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unarchive a shipment (buyer only)' })
  @ApiResponse({ status: 200, description: 'Shipment unarchived' })
  @ApiResponse({ status: 403, description: 'Only the buyer can unarchive' })
  @ApiResponse({ status: 409, description: 'Shipment is not archived' })
  unarchive(@Param('id') id: string, @CurrentUser() user: any) {
    return this.shipmentsService.unarchive(id, user.stellarAddress);
  }

  /**
   * GET /api/v1/shipments/:id/my-role
   * Return the caller's participant role without exposing full shipment data.
   * Non-participants receive { role: null } with 200 instead of 403.
   */
  @Get(':id/my-role')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Get the caller's participant role for a shipment" })
  @ApiResponse({ status: 200, description: "Role: BUYER | SUPPLIER | LOGISTICS | ARBITER | ADMIN | null" })
  myRole(@Param('id') id: string, @CurrentUser() user: any) {
    return this.shipmentsService.getCallerRole(id, user.stellarAddress, user.role === UserRole.ADMIN);
  }

  /**
   * POST /api/v1/shipments/:id/sync
   */
  @Post(':id/sync')
  @UseGuards(ShipmentParticipantGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force sync shipment status from Stellar chain' })
  sync(@Param('id') id: string) {
    return this.shipmentsService.syncStatusFromChain(id);
  }

  /**
   * POST /api/v1/shipments/:id/tracking
   * Submit a tracking update (location, status, ETA). Restricted to logistics participant.
   * Tracking updates are immutable after submission.
   */
  @Post(':id/tracking')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a tracking update for a shipment (logistics only)' })
  @ApiResponse({ status: 201, description: 'Tracking update created' })
  @ApiResponse({ status: 403, description: 'Only logistics participant can submit' })
  @ApiResponse({ status: 404, description: 'Shipment not found' })
  createTracking(@Param('id') id: string, @Body() dto: CreateTrackingDto, @CurrentUser() user: any) {
    return this.shipmentsService.createTracking(id, user.stellarAddress, dto);
  }

    /**
     * GET /api/v1/shipments/:id/tracking
     * Get all tracking updates for a shipment in chronological order.
     * Restricted to shipment participants.
     */
    @Get(':id/tracking')
    @UseGuards(ShipmentParticipantGuard)
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get all tracking updates for a shipment in chronological order' })
    @ApiResponse({ status: 200, description: 'Tracking updates retrieved' })
    @ApiResponse({ status: 403, description: 'Not a shipment participant' })
    getTracking(@Param('id') id: string, @CurrentUser() user: any) {
      return this.shipmentsService.getTracking(id, user.stellarAddress);
    }
}