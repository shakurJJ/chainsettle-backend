import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { KycService } from './kyc.service';
import { KycWebhookDto } from './dto/kyc-webhook.dto';
import { KycRequirementsQueryDto } from './dto/kyc-requirements-query.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('kyc')
@Controller('kyc')
export class KycController {
  constructor(private readonly kycService: KycService) {}

  @Get('requirements')
  @Public()
  @ApiOperation({ summary: 'Get the required KYC tier/documents for a given estimated shipment value' })
  @ApiResponse({ status: 200, description: 'Required tier ("none" | "basic" | "enhanced") and document list' })
  getRequirements(@Query() query: KycRequirementsQueryDto) {
    return this.kycService.getRequirements(BigInt(query.value));
  }

  @Post('initiate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Begin KYC verification for the authenticated user' })
  @ApiResponse({ status: 200, description: 'Verification initiated — provider reference returned' })
  initiate(@CurrentUser('id') userId: string) {
    return this.kycService.initiateVerification(userId);
  }

  @Get('status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the authenticated user's KYC verification status" })
  @ApiResponse({ status: 200, description: 'Current KYC status' })
  getStatus(@CurrentUser('id') userId: string) {
    return this.kycService.getStatus(userId);
  }

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Provider callback — applies a completed KYC verification result' })
  @ApiResponse({ status: 200, description: 'KYC status updated' })
  @ApiResponse({ status: 401, description: 'Invalid webhook signature' })
  @ApiResponse({ status: 404, description: 'No matching user for the reference/address' })
  handleWebhook(
    @Body() dto: KycWebhookDto,
    @Headers('x-kyc-signature') signature?: string,
  ) {
    return this.kycService.handleWebhook(dto, signature);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Withdraw a still-pending KYC submission belonging to the authenticated user' })
  @ApiParam({ name: 'id', description: 'The verification reference returned by POST /kyc/initiate' })
  @ApiResponse({ status: 200, description: 'Submission withdrawn' })
  @ApiResponse({ status: 404, description: 'No matching pending submission for this user' })
  @ApiResponse({ status: 409, description: 'Submission has already been approved or rejected' })
  withdraw(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.kycService.withdraw(userId, id);
  }
}
