import {
  Controller,
  Post,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { BlockImpersonation } from '../../common/decorators/block-impersonation.decorator';

/**
 * Admin user support tools under /admin/users/*
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@BlockImpersonation()
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /api/v1/admin/users/:id/impersonate
   * Issues a short-lived JWT that acts as the target user, tagged with the admin's identity.
   */
  @Post(':id/impersonate')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Admin] Obtain a short-lived impersonation token for support debugging',
    description:
      'Returns a JWT scoped to the target user. The token embeds the impersonating admin ID. ' +
      'Every request made with it is audit-logged with both admin and target user IDs. ' +
      'Sensitive actions (email change, account deletion) are blocked while impersonating.',
  })
  @ApiResponse({ status: 200, description: 'Impersonation token issued' })
  @ApiResponse({ status: 403, description: 'Admin access required / cannot impersonate self or another admin' })
  @ApiResponse({ status: 404, description: 'User not found' })
  impersonate(
    @Param('id') id: string,
    @CurrentUser() admin: any,
    @Req() req: Request,
  ) {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      (req.headers['x-real-ip'] as string) ||
      req.socket?.remoteAddress;

    return this.authService.impersonateUser(id, admin.id, admin.stellarAddress, ip);
  }
}
