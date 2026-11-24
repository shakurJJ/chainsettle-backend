import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import { Request } from 'express';
import { ApiKeysService } from '../api-keys.service';
import { AuditService } from '../../audit/audit.service';
import { getClientIp } from '../../common/utils/ip.util';
import { ipMatchesAnyCidr } from '../../common/utils/cidr.util';

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(Strategy, 'api-key') {
  constructor(
    private readonly apiKeysService: ApiKeysService,
    private readonly auditService: AuditService,
  ) {
    super();
  }

  async validate(req: Request): Promise<any> {
    const rawKey = this.extractKey(req);
    if (!rawKey) {
      throw new UnauthorizedException('Missing API key');
    }

    const apiKey = await this.apiKeysService.validateKey(rawKey);
    if (!apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    const allowedCidrs: string[] = apiKey.allowedCidrs ?? [];
    if (allowedCidrs.length > 0) {
      const clientIp = getClientIp(req);
      if (!clientIp || !ipMatchesAnyCidr(clientIp, allowedCidrs)) {
        await this.auditService.log({
          action: 'api_key.ip_blocked',
          actorId: apiKey.id,
          metadata: { clientIp, allowedCidrs },
        });
        throw new ForbiddenException({
          code: 'API_KEY_IP_NOT_ALLOWED',
          message: 'Client IP is not allowed for this API key',
        });
      }
    }

    return apiKey;
  }

  private extractKey(req: Request): string | undefined {
    const header = req.headers['x-api-key'];
    if (typeof header === 'string' && header.length > 0) {
      return header;
    }
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return auth.slice('Bearer '.length);
    }
    return undefined;
  }
}
