import { BadRequestException } from '@nestjs/common';
import { promises as dns } from 'dns';
import * as net from 'net';

/**
 * SSRF protection for user-supplied webhook URLs (#636).
 *
 * Rejects loopback, link-local (incl. cloud metadata 169.254.169.254),
 * private RFC 1918, CGNAT, unspecified, multicast and IPv6 unique-local targets.
 * Set WEBHOOK_ALLOW_PRIVATE_URLS=true to bypass — ignored when NODE_ENV=production.
 */

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // unspecified / "this" network
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local / cloud metadata
  ['172.16.0.0', 12], // RFC 1918
  ['192.168.0.0', 16], // RFC 1918
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved / broadcast
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0];
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d)
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true;
}

function overrideEnabled(): boolean {
  return (
    process.env.WEBHOOK_ALLOW_PRIVATE_URLS === 'true' && process.env.NODE_ENV !== 'production'
  );
}

/**
 * Resolves the URL's hostname and throws BadRequestException if any resolved
 * address is private/internal. Call on create/update AND before every delivery
 * (covers DNS rebinding).
 */
export async function assertPublicWebhookUrl(rawUrl: string): Promise<void> {
  if (overrideEnabled()) return;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Invalid webhook URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BadRequestException('Webhook URL must use http or https');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new BadRequestException(`Webhook host "${host}" could not be resolved`);
    }
  }

  const blocked = addresses.find(isPrivateAddress);
  if (blocked) {
    throw new BadRequestException(
      `Webhook URL resolves to a private or internal address (${blocked}) and is not allowed`,
    );
  }
}
