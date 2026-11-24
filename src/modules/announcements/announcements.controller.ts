import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AnnouncementsService } from './announcements.service';
import { CreateAnnouncementDto, ListAnnouncementsQueryDto, UpdateAnnouncementDto } from './dto/announcement.dto';

@ApiTags('announcements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get('active')
  @ApiOperation({
    summary: "Active, non-dismissed announcements for the caller's role",
  })
  @ApiResponse({
    status: 200,
    description: 'Announcements ordered CRITICAL → WARNING → INFO',
  })
  active(@CurrentUser('id') userId: string, @CurrentUser('role') role: UserRole) {
    return this.announcements.findActiveForUser(userId, role);
  }

  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dismiss an announcement for the authenticated user',
  })
  @ApiResponse({ status: 404, description: 'Announcement not found' })
  dismiss(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string) {
    return this.announcements.dismiss(id, userId);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/announcements')
export class AdminAnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Create an announcement' })
  @ApiResponse({
    status: 400,
    description: 'Invalid schedule (endsAt must be after startsAt)',
  })
  create(@Body() dto: CreateAnnouncementDto, @CurrentUser('id') adminId: string) {
    return this.announcements.create(dto, adminId);
  }

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: '[Admin] List all announcements, including scheduled and expired',
  })
  findAll(@Query() query: ListAnnouncementsQueryDto) {
    return this.announcements.findAll(query.page, query.limit);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Get an announcement' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.findOne(id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Update an announcement' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAnnouncementDto) {
    return this.announcements.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Delete an announcement' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.remove(id);
  }
}
