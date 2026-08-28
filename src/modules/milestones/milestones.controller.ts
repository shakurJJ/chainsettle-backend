import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Res,
  Header,
  NotFoundException,
} from '@nestjs/common';

import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { MilestonesService } from './milestones.service';
import { AppendMilestoneDto } from './dto/append-milestone.dto';
import { ConfirmMilestoneDto } from './dto/confirm-milestone.dto';
import { BulkConfirmMilestonesDto } from './dto/bulk-confirm-milestones.dto';
import { RebalanceMilestonesDto } from './dto/rebalance-milestones.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ShipmentParticipantGuard } from '../shipments/guards/shipment-participant.guard';
import { StellarAddressThrottlerGuard } from '../../common/guards/stellar-address-throttler.guard';
import { Throttle } from '@nestjs/throttler';
import { CalendarService } from './calendar.service';

/** Maximum allowed proof file size: 50 MB */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** Accepted MIME types for proof documents */
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
];

@ApiTags('milestones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('shipments/:shipmentId/milestones')
export class MilestonesController {
  constructor(
    private readonly milestonesService: MilestonesService,
    private readonly calendar: CalendarService,
  ) {}

  /**
   * GET /api/v1/shipments/:shipmentId/milestones/calendar.ics
   * iCalendar feed of this shipment's milestone due dates.
   *
   * Declared before the ':milestoneIndex' routes so the param route does not
   * swallow "calendar.ics".
   */
  @Get('calendar.ics')
  @UseGuards(ShipmentParticipantGuard)
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  @ApiOperation({ summary: "Export a shipment's milestone due dates as an iCalendar file" })
  @ApiResponse({ status: 200, description: 'iCalendar document' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  async getCalendar(
    @Param('shipmentId') shipmentId: string,
    @Res() res: Response,
  ) {
    const body = await this.calendar.renderShipmentCalendar(shipmentId);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${shipmentId}-milestones.ics"`,
    );
    res.send(body);
  }

  @Get()
  @UseGuards(ShipmentParticipantGuard)
  @ApiOperation({ summary: 'List all milestones for a shipment with optional filters' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'PROOF_SUBMITTED', 'CONFIRMED', 'DISPUTED', 'RESOLVED'] })
  @ApiQuery({ name: 'overdue', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'List of milestones with isOverdue computed' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  @ApiResponse({ status: 404, description: 'Shipment not found' })
  findAll(
    @Param('shipmentId') shipmentId: string,
    @Query('status') status?: string,
    @Query('overdue') overdue?: string,
  ) {
    const isOverdueFilter = overdue === 'true';
    return this.milestonesService.findByShipment(shipmentId, status, isOverdueFilter);
  }

  /**
   * POST /api/v1/shipments/:shipmentId/milestones
   *
   * Append a new milestone to a shipment before any work has started.
   * Only allowed when ALL existing milestones are still PENDING (no proof
   * submitted on any milestone yet).
   *
   * Restricted to the shipment buyer. This is DB-only bookkeeping; the
   * frontend must also submit the corresponding on-chain transaction.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ShipmentParticipantGuard)
  @ApiOperation({ summary: 'Append a milestone before any work starts (buyer only)' })
  @ApiResponse({ status: 201, description: 'Milestone appended' })
  @ApiResponse({ status: 400, description: 'Payment percent sum would exceed 100' })
  @ApiResponse({ status: 403, description: 'Not the shipment buyer' })
  @ApiResponse({ status: 404, description: 'Shipment not found' })
  @ApiResponse({ status: 409, description: 'Work has already started (milestone not PENDING)' })
  appendMilestone(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: AppendMilestoneDto,
    @CurrentUser() user: any,
  ) {
    const callerAddress: string = user?.stellarAddress ?? user?.sub;
    return this.milestonesService.appendMilestone(shipmentId, callerAddress, dto);
  }

  @Get(':index/dispute')
  @ApiOperation({ summary: 'Get dispute detail for a milestone' })
  @ApiResponse({ status: 200, description: 'Dispute detail returned' })
  @ApiResponse({ status: 404, description: 'Milestone not found' })
  getDisputeDetail(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.milestonesService.getDisputeDetail(shipmentId, index);
  }

  @Get(':index')
  @ApiOperation({ summary: 'Get a single milestone by index' })
  findOne(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.milestonesService.findOne(shipmentId, index);
  }

  /**
   * POST /api/v1/shipments/:shipmentId/milestones/:index/proof
   *
   * Accepts a multipart/form-data upload with a "file" field containing
   * the proof document. Pins it to IPFS via Pinata, stores the resulting
   * CID in the database, and notifies the buyer.
   *
   * Restricted to the shipment's supplierAddress or logisticsAddress.
   */
  @Post(':index/proof')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, StellarAddressThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @ApiOperation({
    summary: 'Submit proof of delivery for a milestone',
    description:
      'Pins the uploaded file to IPFS (via Pinata) and stores the CID in the milestone record. ' +
      'Only the shipment\'s supplierAddress or logisticsAddress may call this endpoint. ' +
      'Rate limited to 5 uploads per hour per user.',
  })
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
            'Proof document (PDF, image, or video). Maximum 50 MB.',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Proof pinned to IPFS and milestone updated',
    schema: {
      example: {
        milestone: {
          id: 'uuid',
          shipmentId: 'ship-001',
          milestoneIndex: 0,
          status: 'PROOF_SUBMITTED',
          proofHash: 'bafybeig...',
        },
        cid: 'bafybeig...',
        gatewayUrl: 'https://gateway.pinata.cloud/ipfs/bafybeig...',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'No file uploaded or invalid type' })
  @ApiResponse({ status: 403, description: 'Caller is not the supplier or logistics provider' })
  @ApiResponse({ status: 404, description: 'Shipment or milestone not found' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded - maximum 5 uploads per hour' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE },
      fileFilter(
        _req,
        file: Express.Multer.File,
        callback: (error: Error | null, acceptFile: boolean) => void,
      ) {
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          return callback(
            new BadRequestException(
              `Unsupported file type: ${file.mimetype}. Allowed: PDF, images, MP4.`,
            ),
            false,
          );
        }
        callback(null, true);
      },
    }),
  )
  async submitProof(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    if (!file) {
      throw new BadRequestException('A proof file must be provided in the "file" field');
    }

    // The JWT payload carries the Stellar address as `sub` or `stellarAddress`
    const callerAddress: string = user?.stellarAddress ?? user?.sub;

    return this.milestonesService.submitProof(
      shipmentId,
      index,
      callerAddress,
      file,
    );
  }

  /**
   * POST /api/v1/shipments/:shipmentId/milestones/rebalance
   *
   * Atomically redistributes payment percentages across PENDING milestones.
   * Restricted to the shipment's buyerAddress.
   */
  @Post('rebalance')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rebalance payment percentages across PENDING milestones (buyer only)' })
  @ApiResponse({ status: 200, description: 'All milestones after rebalance' })
  @ApiResponse({ status: 400, description: 'Percentages do not sum to 100' })
  @ApiResponse({ status: 403, description: 'Only the buyer may rebalance' })
  @ApiResponse({ status: 404, description: 'Shipment or milestone not found' })
  @ApiResponse({ status: 409, description: 'A target milestone is not PENDING' })
  rebalance(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: RebalanceMilestonesDto,
    @CurrentUser() user: any,
  ) {
    const callerAddress: string = user?.stellarAddress ?? user?.sub;
    return this.milestonesService.rebalance(shipmentId, callerAddress, dto.milestones);
  }

  /**
   * POST /api/v1/shipments/:shipmentId/milestones/:index/confirm
   * Buyer registers an on-chain milestone confirmation so the DB reflects it immediately.
   */
  @Post(':index/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ShipmentParticipantGuard)
  @ApiOperation({ summary: 'Confirm a milestone (buyer only)' })
  @ApiResponse({ status: 200, description: 'Milestone confirmed' })
  @ApiResponse({ status: 403, description: 'Only the buyer may confirm' })
  @ApiResponse({ status: 404, description: 'Shipment or milestone not found' })
  @ApiResponse({ status: 409, description: 'Milestone not in PROOF_SUBMITTED status' })
  confirm(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: ConfirmMilestoneDto,
    @CurrentUser() user: any,
  ) {
    const callerAddress: string = user?.stellarAddress ?? user?.sub;
    return this.milestonesService.confirmFromApi(
      shipmentId,
      index,
      callerAddress,
      dto.txHash,
      dto.paymentReleased,
    );
  }

  /**
   * DELETE /api/v1/shipments/:shipmentId/milestones/:index
   * Remove a still-pending milestone from a shipment.
   * Only allowed when ALL milestones on the shipment (including the target)
   * are still PENDING. The removed milestone's data is captured in the audit log.
   * Restricted to the shipment buyer.
   */
  @Delete(':index')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ShipmentParticipantGuard)
  @ApiOperation({ summary: 'Remove a still-pending milestone (buyer only)' })
  @ApiResponse({ status: 200, description: 'Milestone removed' })
  @ApiResponse({ status: 400, description: 'Cannot remove the only milestone' })
  @ApiResponse({ status: 403, description: 'Not the shipment buyer' })
  @ApiResponse({ status: 404, description: 'Milestone not found' })
  @ApiResponse({ status: 409, description: 'Milestone not PENDING or work has started' })
  removeMilestone(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
    @CurrentUser() user: any,
  ) {
    const callerAddress: string = user?.stellarAddress ?? user?.sub;
    const callerId: string | undefined = user?.id;
    return this.milestonesService.removeMilestone(shipmentId, index, callerAddress, callerId);
  }

  /**
   * GET /api/v1/shipments/:shipmentId/milestones/:index/proof-history
   * Returns the full proof submission history for a milestone, ordered chronologically.
   */
  @Get(':index/proof-history')
  @UseGuards(ShipmentParticipantGuard)
  @ApiOperation({ summary: 'Get full proof submission history for a milestone' })
  @ApiResponse({ status: 200, description: 'Proof submissions in chronological order' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  @ApiResponse({ status: 404, description: 'Milestone not found' })
  getProofHistory(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.milestonesService.getProofHistory(shipmentId, index);
  }

  /**
   * GET /api/v1/shipments/:shipmentId/milestones/:index/evidence/:evidenceId
   * Fetch a single dispute evidence record by ID.
   * Includes the IPFS gateway URL when an ipfsCid is present.
   */
  @Get(':index/evidence/:evidenceId')
  @ApiOperation({ summary: 'Fetch a single dispute evidence record by ID' })
  @ApiResponse({ status: 200, description: 'Evidence record with ipfsUrl populated' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  @ApiResponse({ status: 404, description: 'Evidence not found or wrong shipment/milestone combination' })
  async getOneEvidence(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
    @Param('evidenceId') evidenceId: string,
    @CurrentUser() user: any,
  ) {
    const callerAddress: string = user?.stellarAddress ?? user?.sub;
    const isAdmin: boolean = user?.role === 'ADMIN';
    return this.milestonesService.getOneEvidence(shipmentId, index, evidenceId, callerAddress, isAdmin);
  }

  /**
   * GET /api/v1/shipments/:shipmentId/milestones/:index/evidence/:evidenceId/download
   * Download a dispute evidence file through the backend proxy.
   */
  @Get(':index/evidence/:evidenceId/download')
  @UseGuards(ShipmentParticipantGuard)
  @ApiOperation({ summary: 'Download dispute evidence file' })
  @ApiResponse({ status: 200, description: 'File streamed' })
  @ApiResponse({ status: 403, description: 'Not a shipment participant' })
  @ApiResponse({ status: 404, description: 'Evidence not found or no file attached' })
  async downloadEvidence(
    @Param('shipmentId') shipmentId: string,
    @Param('index', ParseIntPipe) index: number,
    @Param('evidenceId') evidenceId: string,
    @Res() res: Response,
  ) {
    const { fileBuffer, fileName, mimeType } = await this.milestonesService.downloadEvidence(
      shipmentId,
      index,
      evidenceId,
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.end(fileBuffer);
  }
}
