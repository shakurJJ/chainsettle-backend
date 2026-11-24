import { Controller, Delete, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { EmailSuppressionService } from './email-suppression.service';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/email-suppressions')
export class AdminEmailSuppressionsController {
  constructor(private readonly suppressions: EmailSuppressionService) {}

  @Get()
  @ApiOperation({ summary: '[Admin] List suppressed email addresses' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'email', required: false })
  list(@Query('page') page?: string, @Query('limit') limit?: string, @Query('email') email?: string) {
    return this.suppressions.list({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      email,
    });
  }

  @Delete(':id')
  @ApiOperation({ summary: '[Admin] Remove an address from the suppression list' })
  remove(@Param('id') id: string) {
    return this.suppressions.remove(id);
  }
}
