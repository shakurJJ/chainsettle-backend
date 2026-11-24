import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationsService } from './organizations.service';
import {
  AddOrganizationMemberDto,
  ChangeOrganizationRoleDto,
  CreateOrganizationDto,
} from './dto/organization.dto';

@ApiTags('organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  @ApiOperation({ summary: 'Create an organization (caller becomes OWNER)' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrganizationDto) {
    return this.organizations.create(user.id, dto.name);
  }

  @Get('mine')
  @ApiOperation({ summary: 'List organizations the caller belongs to' })
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.organizations.listMine(user.id);
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'List organization members' })
  listMembers(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.organizations.listMembers(id, user.id);
  }

  @Post(':id/members')
  @ApiOperation({ summary: 'Invite (add) a member — requires ADMIN' })
  addMember(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: AddOrganizationMemberDto) {
    return this.organizations.addMember(
      id,
      user.id,
      { userId: dto.userId, stellarAddress: dto.stellarAddress },
      dto.role,
    );
  }

  @Patch(':id/members/:userId')
  @ApiOperation({ summary: "Change a member's role — requires ADMIN" })
  changeRole(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangeOrganizationRoleDto,
  ) {
    return this.organizations.changeRole(id, user.id, userId, dto.role);
  }

  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a member (or leave) — access is revoked immediately' })
  removeMember(@Param('id') id: string, @Param('userId') userId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.organizations.removeMember(id, user.id, userId);
  }
}
