import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Interface for SMS providers.
 * Allows swapping implementations (Twilio, AWS SNS, etc.)
 */
export interface SmsProvider {
  /**
   * Send an SMS message to a phone number.
   * @param to E.164 formatted phone number (e.g., +14155551234)
   * @param body Message content
   */
  sendSms(to: string, body: string): Promise<void>;
}

/**
 * SMS provider that logs messages (for development/testing).
 */
@Injectable()
export class LoggingSmsProvider implements SmsProvider {
  private readonly logger = new Logger(LoggingSmsProvider.name);

  async sendSms(to: string, body: string): Promise<void> {
    this.logger.log(`[SMS] To: ${to}, Body: ${body}`);
  }
}

/**
 * Twilio SMS provider.
 */
@Injectable()
export class TwilioSmsProvider implements SmsProvider {
  private readonly logger = new Logger(TwilioSmsProvider.name);
  private readonly client: any; // Twilio client
  private readonly fromNumber: string;

  constructor(private readonly config: ConfigService) {
    const accountSid = this.config.get('TWILIO_ACCOUNT_SID');
    const authToken = this.config.get('TWILIO_AUTH_TOKEN');
    this.fromNumber = this.config.get('TWILIO_PHONE_NUMBER');

    if (!accountSid || !authToken || !this.fromNumber) {
      throw new Error('Twilio credentials not configured');
    }

    // Dynamic import to avoid loading twilio when not configured
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    this.client = twilio(accountSid, authToken);
  }

  async sendSms(to: string, body: string): Promise<void> {
    try {
      await this.client.messages.create({
        body,
        from: this.fromNumber,
        to,
      });
      this.logger.log(`SMS sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send SMS to ${to}`, (error as Error).message);
      throw error;
    }
  }
}

/**
 * Factory to create the appropriate SMS provider based on configuration.
 */
@Injectable()
export class SmsProviderFactory {
  private readonly logger = new Logger(SmsProviderFactory.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Create an SMS provider instance based on SMS_PROVIDER config.
   * Returns null if SMS is not enabled.
   */
  create(): SmsProvider | null {
    const provider = this.config.get('SMS_PROVIDER');

    if (!provider || provider === 'none') {
      this.logger.log('SMS provider is disabled');
      return null;
    }

    switch (provider.toLowerCase()) {
      case 'twilio':
        return new TwilioSmsProvider(this.config);
      case 'logging':
        return new LoggingSmsProvider();
      default:
        this.logger.warn(`Unknown SMS provider: ${provider}, using logging`);
        return new LoggingSmsProvider();
    }
  }
}