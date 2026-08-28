import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Res,
  Headers,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiHeader,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ShipmentsService } from './shipments.service';
import { ShipmentApprovalsService } from './shipment-approvals.service';
import { SavedFiltersService } from './saved-filters.service';
import { CreateSavedFilterDto, UpdateSavedFilterDto } from './dto/saved-filter.dto';
import { CreateShipmentDto, UpdateShipmentDto, CancelShipmentDto, CloneShipmentDto, BulkStatusDto, ApproveShipmentDto } from './dto/create-shipment.dto';
import { CreateTrackingDto } from './dto/tracking.dto';
import { FindAllShipmentsDto } from './dto/find-all-shipments.dto';
import { AddTagDto } from './dto/tag.dto';
import { NoteDto } from './dto/note.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ValidateMetadataDto } from './dto/metadata.dto';
import { ShipmentParticipantGuard } from './guards/shipment-participant.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { RedisService } from '../../common/redis/redis.service';

@ApiTags('shipments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('shipments')
export class ShipmentsController {
  constructor(
    private readonly shipmentsService: ShipmentsService,
    private readonly shipmentApprovals: ShipmentApprovalsService,
    private readonly savedFilters: SavedFiltersService,
    private readonly redis: RedisService,
  ) { }

  /**
   * POST /api/v1/shipments
   * Called by the frontend after the buyer has signed and broadcast
   * the create_shipment transaction via Freighter. The backend stores
   * the off-chain metadata and links it to the on-chain shipment.
   *
   * Supports an optional `Idempotency-Key` header (#191).
   * When provided, a second request with the same key returns the cached
   * first response without re-executing — scoped per authenticated user.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a newly created on-chain shipment' })
  @ApiResponse({ status: 201, description: 'Shipment registered successfully' })
  @ApiHeader({
    name: 'Idempotency-Key',
    description:
      'Optional client-generated key (UUID or any opaque string). ' +
      'A second POST with the same key returns the cached first response ' +
      'without re-executing. Scoped per user. TTL: 24 hours.',
    required: false,
  })
  async create(
    @Body() dto: CreateShipmentDto,
    @CurrentUser() user: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (user?.role !== UserRole.ADMIN && dto.buyerAddress !== user?.stellarAddress) {
      return Promise.reject(new ForbiddenException('buyerAddress must match the authenticated user'));
    }

    // Idempotency-Key handling — opt-in, additive (#191)
    if (idempotencyKey) {
      const cacheKey = `idempotency:${user.sub}:${idempotencyKey}`;
      const cached = await this.redis.getJson<{ statusCode: number; body: any }>(cacheKey);
      if (cached) {
        // Return the original cached response body directly
        return cached.body;
      }

      const result = await this.shipmentsService.create(dto);

      // Cache the result with a 24-hour TTL
      await this.redis.setJson(cacheKey, { statusCode: HttpStatus.CREATED, body: result }, 86400);

      return result;
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
  async findAll(@CurrentUser() user: any, @Query() query: FindAllShipmentsDto) {
    if (query.cursor && query.page) {
      throw new BadRequestException('cursor and page are mutually exclusive');
    }

    // A saved preset supplies the base criteria (#239); anything explicitly
    // passed on this request overrides the stored value, so a saved view can
    // be narrowed without being re-saved.
    if (query.savedFilterId) {
      query = await this.savedFilters.applyTo(user.id, query.savedFilterId, query);
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
      isDraft: query.isDraft,
      favorite: query.favorite,
      callerUserId: user?.id,
    });
  }

  /**
   * GET /api/v1/shipments/archived
   * List shipments moved to cold storage by the scheduled archival job.
   */
  @Get('archived')
  @ApiOperation({
    summary: 'List cold-archived shipments',
    description:
      'Returns shipments that were moved out of the hot path after the retention threshold. ' +
      'Full milestone/event/audit history is preserved in each record payload.',
  })
  @ApiResponse({ status: 200, description: 'Paginated cold-archived shipments' })
  findArchived(
    @CurrentUser() user: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    const isAdmin = user?.role === UserRole.ADMIN;
    return this.shipmentsService.findArchived({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      callerStellarAddress: user?.stellarAddress,
      isAdmin,
      status: status as any,
    });
  }

  /**
   * GET /api/v1/shipments/archived/:id
   * Retrieve a single cold-archived shipment with full history snapshot.
   */
  @Get('archived/:id')
  @ApiOperation({ summary: 'Get a cold-archived shipment by id' })
  @ApiResponse({ status: 200, description: 'Archived shipment with full history' })
  @ApiResponse({ status: 404, description: 'Archived shipment not found' })
  findArchivedOne(@Param('id') id: string, @CurrentUser() user: any) {
    const isAdmin = user?.role === UserRole.ADMIN;
    return this.shipmentsService.findArchivedOne(id, user?.stellarAddress, isAdmin);
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
   * POST /api/v1/shipments/import
   * Bulk-import draft shipments from a CSV file.
   * Accepts multipart/form-data with a "file" field containing the CSV.
   * Each row creates a single draft shipment (isDraft=true, no on-chain backing).
   * Maximum 100 rows per request; rows beyond that are rejected with 400.
   * Malformed rows are reported individually — valid rows still succeed.
   */
  @Post('import')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
    }),
  )
  @ApiOperation({ summary: 'Bulk-import draft shipments from CSV (max 100 rows)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            'CSV file with columns: supplierAddress, logisticsAddress, arbiterAddress, ' +
            'tokenAddress, totalAmount, description, referenceNumber',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Import results with per-row status' })
  @ApiResponse({ status: 400, description: 'File too large, no file, or too many rows' })
  async importCsv(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    if (!file) {
      throw new BadRequestException('A CSV file must be provided in the "file" field');
    }

    return this.shipmentsService.importDrafts(
      user?.id,
      user?.stellarAddress ?? user?.sub,
      file.buffer,
    );
  }

  /**
   * PUT /api/v1/shipments/:id/tags
   * Replace all shipment tags in a single request.
   */
  @Put(':id/tags')
  @UseGuards(ShipmentParticipantGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replace all shipment tags' })
  @ApiResponse({ status: 200, description: 'Shipment tags replaced successfully' })
  @ApiResponse({ status: 400, description: 'Invalid tag list' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  replaceTags(@Param('id') id: string, @Body() body: { tags: string[] }, @CurrentUser() user: any) {
    return this.shipmentsService.replaceTags(id, body?.tags, user?.stellarAddress, user?.id);
  }

  /**
   * GET /api/v1/shipments/mine/summary
   * Returns a breakdown of the caller's ACTIVE shipments by participant role.
   */
  @Get('mine/summary')
  @ApiOperation({ summary: "Get ACTIVE shipment counts grouped by the caller's role" })
  @ApiResponse({ status: 200, description: 'Role summary for the caller' })
  getRoleSummary(@CurrentUser() user: any) {
    return this.shipmentsService.getRoleSummary(user.stellarAddress);
  }

  /**
   * GET /api/v1/shipments/:id/participants
   * Returns all four participant roles with Stellar address and name.
   */
  @Post(':id/notes')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an admin note for a shipment' })
  @ApiResponse({ status: 201, description: 'Note created' })
  @ApiResponse({ status: 403, description: 'Only admins may create shipment notes' })
  addNote(@Param('id') id: string, @Body() dto: NoteDto, @CurrentUser() user: any) {
    return this.shipmentsService.addNote(id, user.id, dto.body);
  }

  @Get(':id/notes')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List admin notes for a shipment' })
  @ApiResponse({ status: 200, description: 'Notes returned' })
  @ApiResponse({ status: 403, description: 'Only admins may list shipment notes' })
  listNotes(@Param('id') id: string) {
    return this.shipmentsService.listNotes(id);
  }

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
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.shipmentsService.findOne(id, user?.id);
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
   * POST /api/v1/shipments/:id/metadata/validate
   * Validates a shipment's existing metadata against a built-in schema (e.g. incoterms, customs).
   * Read-only operation; does not mutate metadata.
   */
  @Post(':id/metadata/validate')
  @UseGuards(ShipmentParticipantGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate shipment metadata against a JSON schema' })
  @ApiResponse({ status: 200, description: 'Validation result' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  @ApiResponse({ status: 404, description: 'Shipment not found or no metadata set' })
  validateMetadata(@Param('id') id: string, @Body() dto: ValidateMetadataDto) {
    return this.shipmentsService.validateMetadata(id, dto.schema);
  }

  /**
   * POST /api/v1/shipments/filters
   * Save a named filter preset for the caller.
   */
  @Post('filters')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Save a named GET /shipments filter preset' })
  @ApiResponse({ status: 201, description: 'Saved filter created' })
  @ApiResponse({ status: 400, description: 'Unsupported filter field' })
  @ApiResponse({ status: 409, description: 'A preset of that name already exists' })
  createSavedFilter(@Body() dto: CreateSavedFilterDto, @CurrentUser() user: any) {
    return this.savedFilters.create(user.id, dto.name, dto.filter);
  }

  /**
   * GET /api/v1/shipments/filters
   * List the caller's saved filter presets.
   */
  @Get('filters')
  @ApiOperation({ summary: "List the caller's saved filter presets" })
  @ApiResponse({ status: 200, description: 'Saved filters' })
  listSavedFilters(@CurrentUser() user: any) {
    return this.savedFilters.findAll(user.id);
  }

  /**
   * GET /api/v1/shipments/filters/:filterId
   * Read one of the caller's saved filter presets.
   */
  @Get('filters/:filterId')
  @ApiOperation({ summary: 'Get a saved filter preset' })
  @ApiResponse({ status: 200, description: 'Saved filter' })
  @ApiResponse({ status: 404, description: 'Not found, or not yours' })
  getSavedFilter(@Param('filterId') filterId: string, @CurrentUser() user: any) {
    return this.savedFilters.findOne(user.id, filterId);
  }

  /**
   * PATCH /api/v1/shipments/filters/:filterId
   * Rename a preset, replace its criteria, or both.
   */
  @Patch('filters/:filterId')
  @ApiOperation({ summary: 'Update a saved filter preset' })
  @ApiResponse({ status: 200, description: 'Saved filter updated' })
  @ApiResponse({ status: 404, description: 'Not found, or not yours' })
  @ApiResponse({ status: 409, description: 'A preset of that name already exists' })
  updateSavedFilter(
    @Param('filterId') filterId: string,
    @Body() dto: UpdateSavedFilterDto,
    @CurrentUser() user: any,
  ) {
    return this.savedFilters.update(user.id, filterId, dto);
  }

  /**
   * DELETE /api/v1/shipments/filters/:filterId
   * Delete one of the caller's saved filter presets.
   */
  @Delete('filters/:filterId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a saved filter preset' })
  @ApiResponse({ status: 200, description: 'Saved filter deleted' })
  @ApiResponse({ status: 404, description: 'Not found, or not yours' })
  deleteSavedFilter(
    @Param('filterId') filterId: string,
    @CurrentUser() user: any,
  ) {
    return this.savedFilters.remove(user.id, filterId);
  }

  /**
   * POST /api/v1/shipments/:id/approve
   * Record a co-approver's sign-off on a high-value shipment. Milestone
   * confirmation stays blocked until the approval quorum is met.
   */
  @Post(':id/approve')
  @UseGuards(ShipmentParticipantGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a co-approver sign-off on a shipment' })
  @ApiResponse({ status: 200, description: 'Approval recorded' })
  @ApiResponse({ status: 400, description: 'Shipment does not require multi-signature approval' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  @ApiResponse({ status: 404, description: 'Shipment not found' })
  @ApiResponse({ status: 409, description: 'This address has already approved' })
  approveShipment(
    @Param('id') id: string,
    @Body() dto: ApproveShipmentDto,
    @CurrentUser() user: any,
  ) {
    return this.shipmentApprovals.approve(id, user.stellarAddress, dto?.note);
  }

  /**
   * GET /api/v1/shipments/:id/approvals
   * Approval progress for a shipment.
   */
  @Get(':id/approvals')
  @UseGuards(ShipmentParticipantGuard)
  @ApiOperation({ summary: 'List approvals recorded against a shipment' })
  @ApiResponse({ status: 200, description: 'Approval progress' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  async getShipmentApprovals(@Param('id') id: string) {
    const shipment = await this.shipmentsService.findOne(id);
    return this.shipmentApprovals.getApprovalStatus(
      id,
      (shipment as any).requiredApprovals ?? null,
    );
  }

  /**
   * POST /api/v1/shipments/:id/favorite
   * Star a shipment for quick access (private to the caller).
   */
  @Post(':id/favorite')
  @UseGuards(ShipmentParticipantGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Favorite (star) a shipment for quick access' })
  @ApiResponse({ status: 200, description: 'Shipment favorited' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  @ApiResponse({ status: 404, description: 'Shipment not found' })
  favoriteShipment(@Param('id') id: string, @CurrentUser() user: any) {
    return this.shipmentsService.favoriteShipment(id, user.id);
  }

  /**
   * DELETE /api/v1/shipments/:id/favorite
   * Remove a shipment from the caller's favorites.
   */
  @Delete(':id/favorite')
  @UseGuards(ShipmentParticipantGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unfavorite a shipment' })
  @ApiResponse({ status: 200, description: 'Shipment unfavorited' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  unfavoriteShipment(@Param('id') id: string, @CurrentUser() user: any) {
    return this.shipmentsService.unfavoriteShipment(id, user.id);
  }

  /**
   * POST /api/v1/shipments/:id/watch
   * Subscribe to shipment updates.
   */
  @Post(':id/watch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Watch a shipment for updates' })
  @ApiResponse({ status: 200, description: 'Watching shipment' })
  @ApiResponse({ status: 404, description: 'Shipment not found' })
  watchShipment(@Param('id') id: string, @CurrentUser() user: any) {
    return this.shipmentsService.watchShipment(id, user.stellarAddress);
  }

  /**
   * DELETE /api/v1/shipments/:id/watch
   * Unsubscribe from shipment updates.
   */
  @Delete(':id/watch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unwatch a shipment' })
  @ApiResponse({ status: 200, description: 'Unwatched shipment' })
  unwatchShipment(@Param('id') id: string, @CurrentUser() user: any) {
    return this.shipmentsService.unwatchShipment(id, user.stellarAddress);
  }

  /**
   * GET /api/v1/shipments/:id/watchers
   * Get all watchers for a shipment.
   */
  @Get(':id/watchers')
  @UseGuards(ShipmentParticipantGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all watchers for a shipment' })
  @ApiResponse({ status: 200, description: 'List of watchers' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  getWatchers(@Param('id') id: string) {
    return this.shipmentsService.getWatchers(id);
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
   * GET /api/v1/shipments/:id/refund
   * Returns refund details for a cancelled shipment.
   */
  @Get(':id/refund')
  @UseGuards(ShipmentParticipantGuard)
  @ApiOperation({ summary: 'Get refund details for a cancelled shipment' })
  @ApiResponse({ status: 200, description: 'Refund details' })
  @ApiResponse({ status: 404, description: 'Shipment not found or not cancelled' })
  getRefund(@Param('id') id: string) {
    return this.shipmentsService.getRefundDetail(id);
  }

  /**
   * GET /api/v1/shipments/:id/value-released-over-time
   * Returns a cumulative payment release time series for dashboard charts.
   * Protected by ShipmentParticipantGuard.
   */
  @Get(':id/value-released-over-time')
  @UseGuards(ShipmentParticipantGuard)
  @ApiOperation({ summary: 'Get cumulative payment release time series for charting' })
  @ApiResponse({ status: 200, description: 'Payment release time series with summary' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  @ApiResponse({ status: 404, description: 'Shipment not found' })
  getPaymentTimeSeries(@Param('id') id: string) {
    return this.shipmentsService.getPaymentTimeSeries(id);
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

    /**
     * POST /api/v1/shipments/:id/tags
     * Atomically add a tag to a shipment. Buyer only, shipment must be ACTIVE.
     */
    @Post(':id/tags')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Add a tag to a shipment (buyer only, ACTIVE only)' })
    @ApiResponse({ status: 200, description: 'Tag added successfully' })
    @ApiResponse({ status: 403, description: 'Only the buyer can modify tags' })
    @ApiResponse({ status: 404, description: 'Shipment not found' })
    @ApiResponse({ status: 409, description: 'Tag already exists or shipment is not ACTIVE' })
    addTag(@Param('id') id: string, @Body() dto: AddTagDto, @CurrentUser() user: any) {
      return this.shipmentsService.addTag(id, user.stellarAddress, dto.tag);
    }

    /**
     * DELETE /api/v1/shipments/:id/tags/:tag
     * Atomically remove a tag from a shipment. Buyer only, shipment must be ACTIVE.
     */
    @Delete(':id/tags/:tag')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Remove a tag from a shipment (buyer only, ACTIVE only)' })
    @ApiResponse({ status: 200, description: 'Tag removed successfully' })
    @ApiResponse({ status: 403, description: 'Only the buyer can modify tags' })
    @ApiResponse({ status: 404, description: 'Shipment not found or tag not present' })
    @ApiResponse({ status: 409, description: 'Shipment is not ACTIVE' })
    removeTag(@Param('id') id: string, @Param('tag') tag: string, @CurrentUser() user: any) {
      return this.shipmentsService.removeTag(id, user.stellarAddress, tag);
    }
  }
