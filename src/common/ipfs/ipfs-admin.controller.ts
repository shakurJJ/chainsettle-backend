import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { IpfsService } from './ipfs.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { Roles } from '../decorators/roles.decorator';
import { UpdateIpfsConfigDto } from './dto/update-ipfs-config.dto';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/ipfs-config')
export class IpfsAdminController {
  constructor(private readonly ipfs: IpfsService) {}

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get current IPFS upload limits (admin only)' })
  @ApiResponse({ status: 200, description: 'Effective upload limits (admin override or env defaults)' })
  @ApiResponse({ status: 403, description: 'Not authorized (admin only)' })
  getConfig() {
    return this.ipfs.getUploadLimits();
  }

  @Patch()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update IPFS upload limits (admin only)' })
  @ApiResponse({ status: 200, description: 'Upload limits updated' })
  @ApiResponse({ status: 400, description: 'Invalid config values' })
  @ApiResponse({ status: 403, description: 'Not authorized (admin only)' })
  updateConfig(@Body() dto: UpdateIpfsConfigDto) {
    return this.ipfs.updateUploadLimits(dto);
  }
}
