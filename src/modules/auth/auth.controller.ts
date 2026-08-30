import { Controller, Post, Get, Body, Query, HttpCode, HttpStatus, UseGuards, BadRequestException, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { StellarAddressThrottlerGuard } from '../../common/guards/stellar-address-throttler.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('nonce')
  @UseGuards(StellarAddressThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Get a challenge nonce for a Stellar address' })
  @ApiResponse({ status: 200, description: 'Returns a nonce to be signed by the wallet' })
  @ApiResponse({ status: 429, description: 'Too many requests - rate limit exceeded' })
  async getNonce(@Query('address') address: string) {
    const nonce = await this.authService.generateNonce(address);
    return { nonce, address };
  }

  @Post('login')
  @UseGuards(StellarAddressThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify signed nonce and receive a JWT' })
  @ApiResponse({ status: 200, description: 'Returns JWT access token' })
  @ApiResponse({ status: 429, description: 'Too many requests - rate limit exceeded' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    const userAgent = req.headers['user-agent'] ?? 'unknown';
    const ipAddress =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.socket?.remoteAddress ??
      'unknown';
    return this.authService.login(dto, userAgent, ipAddress);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Invalidate the current JWT session' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  logout(@CurrentUser() user: any) {
    if (!user?.jti || !user?.exp) {
      // Token was issued before session tracking was added — nothing to invalidate
      return { message: 'Logged out successfully' };
    }
    return this.authService.logout(user.id, user.jti, user.exp);
  }

  @Get('verify-email')
  @ApiOperation({ summary: 'Verify email address via signed token' })
  @ApiResponse({ status: 200, description: 'Email verified successfully' })
  @ApiResponse({ status: 401, description: 'Invalid or expired token' })
  async verifyEmail(@Query('token') token: string) {
    return this.authService.verifyEmail(token);
  }

  @Post('resend-verification')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 1, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend the pending email verification link' })
  @ApiResponse({ status: 200, description: 'Verification email resent' })
  @ApiResponse({ status: 400, description: 'No pending email to verify' })
  @ApiResponse({ status: 429, description: 'Too many requests - rate limit exceeded' })
  async resendVerification(@CurrentUser() user: any) {
    if (!user?.id) {
      throw new BadRequestException('User not found');
    }

    return this.authService.resendVerificationEmail(user.id);
  }
}
