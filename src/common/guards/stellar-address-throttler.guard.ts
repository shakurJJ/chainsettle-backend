import { Injectable } from '@nestjs/common';
import { RateLimitThrottlerGuard } from './rate-limit-throttler.guard';

/**
 * Custom throttler guard that uses Stellar address as the throttle key
 * instead of IP address. This prevents shared NAT/proxy users from
 * blocking each other while still rate-limiting per address.
 * Inherits X-RateLimit-* header behavior from RateLimitThrottlerGuard.
 */
@Injectable()
export class StellarAddressThrottlerGuard extends RateLimitThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // For GET /auth/nonce, use the address query parameter
    if (req.query?.address) {
      return req.query.address;
    }

    // For POST /auth/login, use the stellarAddress from body
    if (req.body?.stellarAddress) {
      return req.body.stellarAddress;
    }

    // Fallback to IP-based throttling if no address is found
    return req.ips.length > 0 ? req.ips[0] : req.ip;
  }
}
