// jwt.strategy.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SessionService } from './session.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: any) {
    if (!payload?.sub) {
      throw new UnauthorizedException('Invalid token');
    }

    // Check blocklist — tokens invalidated via logout are rejected immediately
    if (payload.jti && await this.sessions.isBlocked(payload.jti)) {
      throw new UnauthorizedException('Token has been revoked');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        stellarAddress: true,
        role: true,
        deactivatedAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.deactivatedAt) {
      throw new UnauthorizedException('Account has been deactivated');
    }

    const isImpersonation = payload.isImpersonation === true;

    // If this is an impersonation token, ensure the admin still exists and is active
    if (isImpersonation) {
      if (!payload.impersonatorAdminId) {
        throw new UnauthorizedException('Invalid impersonation token');
      }

      const admin = await this.prisma.user.findUnique({
        where: { id: payload.impersonatorAdminId },
        select: { id: true, stellarAddress: true, role: true, deactivatedAt: true },
      });

      if (!admin || admin.deactivatedAt || admin.role !== 'ADMIN') {
        throw new UnauthorizedException('Impersonation token is no longer valid');
      }
    }

    return {
      id: user.id,
      stellarAddress: user.stellarAddress,
      role: user.role,
      isImpersonation,
      impersonatorAdminId: isImpersonation ? payload.impersonatorAdminId : undefined,
      impersonatorAddress: isImpersonation ? payload.impersonatorAddress : undefined,
      jti: payload.jti as string | undefined,
      exp: payload.exp as number | undefined,
    };
  }
}
