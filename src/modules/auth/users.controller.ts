import {
  Controller,
  Get,
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
