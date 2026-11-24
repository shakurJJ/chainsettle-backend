import {
  Controller,
  Post,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { BlockImpersonation } from '../../common/decorators/block-impersonation.decorator';
import { ForceLogoutDto } from './dto/force-logout.dto';

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
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      (req.headers['x-real-ip'] as string) ||
      req.socket?.remoteAddress;

    return this.authService.impersonateUser(id, admin.id, admin.stellarAddress, ip);
  }

  /**
   * POST /api/v1/admin/users/:id/force-logout
   * Immediately signs a user out everywhere by revoking all active sessions and optionally revoking API keys.
   */
  @Post(':id/force-logout')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Admin] Force logout a user everywhere (revoke all sessions and optionally API keys)',
    description:
      'Immediately revokes all active JWT sessions for the target user. ' +
      'Optionally revokes all active API keys when revokeApiKeys is true. ' +
      'All revoked tokens will be rejected on subsequent requests. ' +
      'An audit log entry is recorded with the admin as actor. ' +
      'Action is blocked while impersonating.',
  })
  @ApiParam({ name: 'id', description: 'User ID to force log out' })
  @ApiResponse({ status: 200, description: 'User force-logged out successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden: Admin access required or action blocked during impersonation' })
  @ApiResponse({ status: 404, description: 'User not found' })
  forceLogout(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: ForceLogoutDto,
    @Req() req: Request,
  ) {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      (req.headers['x-real-ip'] as string) ||
      req.socket?.remoteAddress;

    return this.authService.forceLogoutUser(id, admin.id, admin.stellarAddress, dto, ip);
  }
}

