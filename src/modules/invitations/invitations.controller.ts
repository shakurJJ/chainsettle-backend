import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { InvitationsService } from './invitations.service';

@ApiTags('invitations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @ApiOperation({ summary: 'Invite a counterparty by email (20 per user per day)' })
  @ApiResponse({ status: 429, description: 'Daily invitation limit reached' })
  create(@Body() dto: CreateInvitationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.invitations.create(user, dto);
  }

  @Get('sent')
  @ApiOperation({ summary: 'List invitations sent by the current user' })
  listSent(@CurrentUser('id') userId: string) {
    return this.invitations.listSent(userId);
  }

  @Post(':token/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept an invitation with the authenticated wallet' })
  @ApiResponse({ status: 410, description: 'Invitation expired or already used' })
  accept(@Param('token') token: string, @CurrentUser() user: AuthenticatedUser) {
    return this.invitations.accept(token, user);
  }
}
