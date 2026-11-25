import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'crypto';
import {
  KycProvider,
  KycSession,
  KycWebhookPayload,
} from '../kyc-provider.interface';

@Injectable()
export class HmacKycProvider implements KycProvider {
  private readonly logger = new Logger(HmacKycProvider.name);
  private readonly secret: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.secret = this.configService.get<string>('KYC_WEBHOOK_SECRET');
  }

  async createSession(userId: string): Promise<KycSession> {
    const reference = randomUUID();
    return {
      reference,
      userId,
    };
  }

  async parseWebhook(payload: KycWebhookPayload): Promise<KycWebhookPayload> {
    return payload;
  }

  async verifySignature(
    payload: KycWebhookPayload,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    if (!this.secret) {
      this.logger.warn(
        'KYC_WEBHOOK_SECRET is not configured; skipping webhook signature verification',
      );
      return true;
    }

    const rawHeader = headers['x-kyc-signature'];
    const providedSignature = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (!providedSignature) {
      return false;
    }

    const expectedSignature = createHmac('sha256', this.secret)
      .update(JSON.stringify(payload))
      .digest('hex');

    return providedSignature === expectedSignature;
  }
}