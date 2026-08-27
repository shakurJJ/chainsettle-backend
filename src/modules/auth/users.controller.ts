import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  ForbiddenException,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('users')
@Controller('users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UsersController {
  constructor(private readonly authService: AuthService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get the authenticated user profile' })
  @ApiResponse({ status: 200, description: 'Returns user profile' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getProfile(@CurrentUser() user: any) {
    return this.authService.getProfile(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update user profile (name, email)' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  updateProfile(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(user.id, dto);
  }

  @Get('me/export')
  @Throttle({ default: { limit: 3, ttl: 60 * 60 * 1000 } })
  @ApiOperation({
    summary: "Export the authenticated user's personal data (GDPR/CCPA)",
    description:
      'Returns a complete JSON bundle of the caller\'s own profile, shipments they are party to, ' +
      'comments, notifications, and audit log entries. Other participants on shared records are only ' +
      'ever identified by their public Stellar address — never their name or email.',
  })
  @ApiResponse({ status: 200, description: 'Full data export for the authenticated user' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  exportMyData(@CurrentUser('id') userId: string) {
    return this.authService.exportUserData(userId);
  }

  @Delete('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate the authenticated user account',
    description:
      'Soft-deactivates the account (sets deactivatedAt). The user row and historical data remain for referential integrity. Rejected if the user has any ACTIVE shipments as buyer, supplier, logistics, or arbiter.',
  })
  @ApiResponse({ status: 200, description: 'Account deactivated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 409,
    description: 'User has active shipments that must be resolved or transferred first',
  })
  deactivateAccount(@CurrentUser() user: any) {
    return this.authService.deactivateUser(user.id);
  }

  /**
   * GET /api/v1/admin/users
   * Paginated user list with role and email verification filters.
   * Restricted to ADMIN role.
   */
  @Get('admin/users')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] List platform users with role and email verification filters' })
  @ApiResponse({ status: 200, description: 'Paginated user list' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiQuery({ name: 'role', required: false, enum: UserRole })
  @ApiQuery({ name: 'emailVerified', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'orderBy', required: false, enum: ['createdAt', 'name'] })
  findAllUsers(
    @CurrentUser() user: any,
    @Query('role') role?: UserRole,
    @Query('emailVerified') emailVerified?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('orderBy') orderBy?: 'createdAt' | 'name',
  ) {
    if (user?.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Admin access required');
    }
    return this.authService.findAllUsers({
      role,
      emailVerified: emailVerified !== undefined ? emailVerified === 'true' : undefined,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      orderBy,
    });
  }

  /**
   * POST /api/v1/users/admin/:id/deactivate
   * Admin-only suspension, bypassing the self-service active-shipment check.
   */
  @Post('admin/:id/deactivate')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Deactivate a user account, bypassing the active-shipment check' })
  @ApiResponse({ status: 200, description: 'Account deactivated (or already deactivated)' })
  @ApiResponse({ status: 400, description: 'Admins cannot deactivate their own account via this route' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 404, description: 'User not found' })
  deactivateUserAsAdmin(@Param('id') id: string, @CurrentUser() user: any) {
    return this.authService.adminSetActive(id, false, user.id, user.stellarAddress);
  }

  /**
   * POST /api/v1/users/admin/:id/reactivate
   */
  @Post('admin/:id/reactivate')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Reactivate a previously deactivated user account' })
  @ApiResponse({ status: 200, description: 'Account reactivated (or already active)' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 404, description: 'User not found' })
  reactivateUserAsAdmin(@Param('id') id: string, @CurrentUser() user: any) {
    return this.authService.adminSetActive(id, true, user.id, user.stellarAddress);
  }

  /**
   * GET /api/v1/users/admin/:id
   * Registered after admin/users (list) so the literal segment isn't
   * shadowed by this param route, and before :stellarAddress below.
   */
  @Get('admin/:id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Get full detail view of a single user' })
  @ApiResponse({ status: 200, description: 'Full user record plus computed operational counts' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 404, description: 'User not found' })
  getAdminUserDetail(@Param('id') id: string) {
    return this.authService.getAdminUserDetail(id);
  }

  @Get(':stellarAddress')
  @ApiOperation({ summary: 'Get public profile by Stellar address' })
  @ApiResponse({ status: 200, description: 'Returns public profile' })
  @ApiResponse({ status: 400, description: 'Invalid Stellar address format' })
  @ApiResponse({ status: 404, description: 'User not found' })
  getPublicProfile(@Param('stellarAddress') stellarAddress: string) {
    if (!/^G[A-Z2-7]{55}$/.test(stellarAddress)) {
      throw new BadRequestException('Invalid Stellar address format');
    }
    return this.authService.getPublicProfile(stellarAddress);
  }

  @Patch('admin/:id/role')
  @ApiOperation({ summary: "[Admin] Change a user's role" })
  @ApiResponse({ status: 200, description: 'Updated user profile' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 409, description: 'Admins cannot demote themselves' })
  updateRole(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateUserRoleDto,
  ) {
    if (user?.role !== 'ADMIN') {
      throw new ForbiddenException('Admin access required');
    }
    return this.authService.updateUserRole(id, user.id, user.stellarAddress, dto.role);
  }
}
