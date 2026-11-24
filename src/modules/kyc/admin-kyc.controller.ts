import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { KycReviewService, KycReviewer } from './kyc-review.service';
import { KycApproveDto, KycQueueQueryDto, KycRejectDto } from './dto/kyc-review.dto';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/kyc')
export class AdminKycController {
  constructor(private readonly review: KycReviewService) {}

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Manual KYC review queue, oldest first' })
  @ApiResponse({
    status: 200,
    description: 'Paginated users with KYC status, reference and age in hours',
  })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  queue(@Query() query: KycQueueQueryDto) {
    return this.review.listQueue(query.status, query.page, query.limit);
  }

  @Post(':userId/approve')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Approve a pending KYC case' })
  @ApiParam({ name: 'userId' })
  @ApiResponse({ status: 409, description: 'Case is not PENDING' })
  approve(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: KycApproveDto,
    @CurrentUser() admin: KycReviewer,
  ) {
    return this.review.approve(userId, admin, dto.reason);
  }

  @Post(':userId/reject')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Reject a pending KYC case with a reason' })
  @ApiParam({ name: 'userId' })
  @ApiResponse({ status: 409, description: 'Case is not PENDING' })
  reject(@Param('userId', ParseUUIDPipe) userId: string, @Body() dto: KycRejectDto, @CurrentUser() admin: KycReviewer) {
    return this.review.reject(userId, admin, dto.reason);
  }
}
