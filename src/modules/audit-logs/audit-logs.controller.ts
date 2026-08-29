import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { Response } from 'express';
import { UserRole } from '@prisma/client';
import { AuditLogService } from './audit-log.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/audit-logs')
export class AuditLogsController {
  constructor(private readonly auditLogService: AuditLogService) {}

  /**
   * GET /api/v1/admin/audit-logs
   * Retrieve audit logs with optional filtering.
   * Restricted to users with role = ADMIN.
   */
  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get audit logs (admin only)' })
  @ApiResponse({ status: 200, description: 'Audit logs retrieved' })
  @ApiResponse({ status: 403, description: 'Not authorized (admin only)' })
  @ApiQuery({ name: 'actorAddress', required: false, description: 'Filter by actor Stellar address' })
  @ApiQuery({ name: 'action', required: false, description: 'Filter by action (substring match)' })
  @ApiQuery({ name: 'resourceType', required: false, description: 'Filter by resource type' })
  @ApiQuery({ name: 'resourceId', required: false, description: 'Filter by resource ID' })
  @ApiQuery({ name: 'startDate', required: false, type: String, description: 'ISO 8601 start date' })
  @ApiQuery({ name: 'endDate', required: false, type: String, description: 'ISO 8601 end date' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default 50)' })
  async findAll(
    @Query('actorAddress') actorAddress?: string,
    @Query('action') action?: string,
    @Query('resourceType') resourceType?: string,
    @Query('resourceId') resourceId?: string,
    @Query('startDate') startDateStr?: string,
    @Query('endDate') endDateStr?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const startDate = startDateStr ? new Date(startDateStr) : undefined;
    const endDate = endDateStr ? new Date(endDateStr) : undefined;

    return this.auditLogService.findAll({
      actorAddress,
      action,
      resourceType,
      resourceId,
      startDate,
      endDate,
      page,
      limit,
    });
  }

  /**
   * GET /api/v1/admin/audit-logs/resource/:resourceType/:resourceId
   * Get all audit logs for a specific resource (read-only for details).
   */
  @Get('export')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Export audit logs as CSV (admin only)' })
  @ApiResponse({ status: 200, description: 'CSV export generated' })
  @ApiResponse({ status: 403, description: 'Not authorized (admin only)' })
  @ApiQuery({ name: 'startDate', required: false, type: String, description: 'ISO 8601 start date' })
  @ApiQuery({ name: 'endDate', required: false, type: String, description: 'ISO 8601 end date' })
  @ApiQuery({ name: 'userId', required: false, type: String, description: 'Filter by user ID' })
  @ApiQuery({ name: 'entityType', required: false, type: String, description: 'Filter by entity type' })
  @ApiQuery({ name: 'entityId', required: false, type: String, description: 'Filter by entity ID' })
  async exportCsv(
    @Query('startDate') startDateStr?: string,
    @Query('endDate') endDateStr?: string,
    @Query('userId') userId?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Res() res?: Response,
  ) {
    const startDate = startDateStr ? new Date(startDateStr) : undefined;
    const endDate = endDateStr ? new Date(endDateStr) : undefined;

    const csv = await this.auditLogService.exportCsv({ startDate, endDate, userId, entityType, entityId });
    res?.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res?.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
    res?.send(csv);
  }

  @Get('resource/:resourceType/:resourceId')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get audit logs for a specific resource (admin only)' })
  @ApiResponse({ status: 200, description: 'Audit logs for resource' })
  @ApiResponse({ status: 403, description: 'Not authorized (admin only)' })
  async findByResource() {
    return { message: 'Use GET /admin/audit-logs with filters instead' };
  }

  /**
   * GET /api/v1/admin/audit-logs/:id
   * Fetch a single audit log entry by its own ID.
   * Declared last so it doesn't swallow the more specific 'export' and
   * 'resource/:resourceType/:resourceId' routes above.
   */
  @Get(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get a single audit log entry by ID (admin only)' })
  @ApiParam({ name: 'id', description: 'Audit log entry ID' })
  @ApiResponse({ status: 200, description: 'Audit log entry retrieved' })
  @ApiResponse({ status: 403, description: 'Not authorized (admin only)' })
  @ApiResponse({ status: 404, description: 'Audit log entry not found' })
  async findOne(@Param('id') id: string) {
    return this.auditLogService.findOne(id);
  }
}
