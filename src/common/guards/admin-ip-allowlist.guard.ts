import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlockList, isIP } from 'net';

/**
 * Restricts /admin routes to the CIDR ranges in ADMIN_ALLOWED_CIDRS (#656).
 *
 * - Comma-separated list, e.g. "10.0.0.0/8,192.168.1.10,2001:db8::/32".
 * - Empty or unset disables the check.
 * - Client IP comes from `req.ip`, which honours Express's `trust proxy`
 *   setting (TRUST_PROXY), so X-Forwarded-For is only used behind a trusted proxy.
 *
 * Registered globally; applies to every route whose path has an `admin` segment.
 */
@Injectable()
export class AdminIpAllowlistGuard implements CanActivate {
  private readonly logger = new Logger(AdminIpAllowlistGuard.name);
  private readonly blockList: BlockList | null;

  constructor(config: ConfigService) {
    this.blockList = AdminIpAllowlistGuard.parse(config.get<string>('ADMIN_ALLOWED_CIDRS'));
  }

  static parse(raw?: string | null): BlockList | null {
    const entries = (raw ?? '').split(',').map((e) => e.trim()).filter(Boolean);
    if (entries.length === 0) return null;

    const list = new BlockList();
    for (const entry of entries) {
      const [addr, prefix] = entry.split('/');
      const family = isIP(addr);
      if (!family) throw new Error(`ADMIN_ALLOWED_CIDRS: invalid address "${entry}"`);
      const type = family === 6 ? 'ipv6' : 'ipv4';
      if (prefix === undefined) list.addAddress(addr, type);
      else list.addSubnet(addr, Number(prefix), type);
    }
    return list;
  }

  static isAllowed(list: BlockList, ip?: string | null): boolean {
    if (!ip) return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    const addr = mapped ? mapped[1] : ip;
    const family = isIP(addr);
    if (!family) return false;
    return list.check(addr, family === 6 ? 'ipv6' : 'ipv4');
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.blockList || context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest();
    const path: string = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (!path.split('/').includes('admin')) return true;

    const ip: string | undefined = req.ip ?? req.socket?.remoteAddress;
    if (AdminIpAllowlistGuard.isAllowed(this.blockList, ip)) return true;

    this.logger.warn(`Blocked admin request from ${ip ?? 'unknown IP'} to ${path}`);
    throw new ForbiddenException('Admin access is not allowed from this network');
  }
}
