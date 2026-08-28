import { Injectable, Logger, ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { StellarService } from '../stellar/stellar.service';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../../modules/audit-logs/audit-log.service';
import { RegisterTokenDto } from './dto/register-token.dto';

export interface TokenInfo {
  symbol: string;
  decimals: number;
  enabled?: boolean;
  displayName?: string;
}

// Tokens pre-populated at compile time. Both USDC and EURC use 7 decimal
// places on Stellar (the Soroban token standard normalises to 7).
const BUILT_IN_TOKENS: Array<{ address: string } & TokenInfo> = [
  { address: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', symbol: 'USDC', decimals: 7, enabled: true, displayName: 'USD Coin' },
  { address: 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO', symbol: 'EURC', decimals: 7, enabled: true, displayName: 'Euro Coin' },
];

@Injectable()
export class TokenRegistryService {
  private readonly logger = new Logger(TokenRegistryService.name);
  private readonly registry = new Map<string, TokenInfo>();

  constructor(
    private readonly config: ConfigService,
    private readonly stellar: StellarService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    this.initRegistry();
  }

  private initRegistry() {
    for (const { address, symbol, decimals } of BUILT_IN_TOKENS) {
      this.registry.set(address, { symbol, decimals });
    }

    // Extend/override via TOKEN_REGISTRY_JSON env var (JSON array of tokens)
    const inlineJson = this.config.get<string>('TOKEN_REGISTRY_JSON');
    if (inlineJson) {
      this.loadFromJson(inlineJson, 'TOKEN_REGISTRY_JSON');
    }

    // Extend/override via TOKEN_REGISTRY_PATH env var (path to JSON file)
    const filePath = this.config.get<string>('TOKEN_REGISTRY_PATH');
    if (filePath) {
      try {
        const content = fs.readFileSync(path.resolve(filePath), 'utf8');
        this.loadFromJson(content, filePath);
      } catch (err) {
        this.logger.warn(`Cannot read token registry file at ${filePath}: ${err.message}`);
      }
    }

    this.logger.log(`Token registry ready with ${this.registry.size} token(s)`);
  }

  private loadFromJson(json: string, source: string) {
    try {
      const tokens: Array<{ address: string; symbol: string; decimals: number; enabled?: boolean; displayName?: string }> = JSON.parse(json);
      for (const token of tokens) {
        this.registry.set(token.address.toUpperCase(), {
          symbol: token.symbol,
          decimals: token.decimals,
          enabled: token.enabled ?? true,
          displayName: token.displayName ?? token.symbol,
        });
      }
      this.logger.log(`Loaded ${tokens.length} token(s) from ${source}`);
    } catch (err) {
      this.logger.warn(`Failed to parse token registry from ${source}: ${err.message}`);
    }
  }

  /**
   * Returns token metadata for a given contract address.
   * Falls back to { symbol: 'UNKNOWN', decimals: 7 } when not found so that
   * existing USDC shipments that pre-date the registry continue to display
   * correctly (7 decimals is the Stellar default).
   */
  getToken(contractAddress: string): TokenInfo {
    const normalized = contractAddress?.toUpperCase();
    const token = this.registry.get(normalized);
    return token ?? { symbol: 'UNKNOWN', decimals: 7, enabled: true, displayName: 'Unknown token' };
  }

  isEnabled(contractAddress: string): boolean {
    const normalized = contractAddress?.toUpperCase();
    return this.registry.get(normalized)?.enabled ?? true;
  }

  /**
   * Returns all registered tokens sorted alphabetically by symbol.
   */
  listTokens(): Array<{ address: string; symbol: string; decimals: number; enabled: boolean; displayName: string }> {
    return Array.from(this.registry.entries())
      .map(([address, { symbol, decimals, enabled = true, displayName = symbol }]) => ({ address, symbol, decimals, enabled, displayName }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  /**
   * Returns the registry entry for a single contract address, or undefined
   * if the address is not registered. Addresses are upper-cased to match
   * the canonical casing Stellar contract/account addresses use elsewhere
   * in the app (see StellarService/Keypair, which always produce upper-case
   * StrKey-encoded addresses).
   */
  findByAddress(address: string): { address: string; symbol: string; decimals: number; enabled: boolean; displayName: string } | undefined {
    const normalized = address?.toUpperCase();
    const token = this.registry.get(normalized);
    return token ? { address: normalized, symbol: token.symbol, decimals: token.decimals, enabled: token.enabled ?? true, displayName: token.displayName ?? token.symbol } : undefined;
  }

  /**
   * Registers a new supported payment token. Verifies the contract is
   * actually deployed on-chain before accepting it, and rejects addresses
   * that are already registered.
   *
   * Note: the registry backing this is in-memory (see BUILT_IN_TOKENS /
   * TOKEN_REGISTRY_JSON / TOKEN_REGISTRY_PATH above) — there's no Token
   * table in the schema, so a token registered here won't survive a
   * restart unless it's also added to TOKEN_REGISTRY_JSON/PATH.
   */
  async registerToken(dto: RegisterTokenDto): Promise<{ address: string; symbol: string; decimals: number; enabled: boolean; displayName: string }> {
    const normalized = dto.address.toUpperCase();

    if (this.registry.has(normalized)) {
      throw new ConflictException(`Token address ${normalized} is already registered`);
    }

    let exists: boolean;
    try {
      exists = await this.stellar.contractExists(normalized);
    } catch (error) {
      throw new BadRequestException(`Could not verify contract ${normalized} on-chain: ${error.message}`);
    }

    if (!exists) {
      throw new BadRequestException(`No contract found at address ${normalized}`);
    }

    const token = {
      symbol: dto.symbol,
      decimals: dto.decimals,
      enabled: true,
      displayName: dto.displayName ?? dto.symbol,
    };

    this.registry.set(normalized, token);
    await this.redis.del('token_registry:list');

    this.logger.log(`Registered new token ${dto.symbol} at ${normalized}`);

    return { address: normalized, symbol: token.symbol, decimals: token.decimals, enabled: token.enabled, displayName: token.displayName };
  }

  async updateToken(address: string, updates: Partial<{ symbol: string; decimals: number; enabled: boolean; displayName: string }>) {
    const normalized = address?.toUpperCase();
    const existing = this.registry.get(normalized);
    if (!existing) {
      throw new NotFoundException(`Token address ${normalized} not found in registry`);
    }

    if (updates.decimals !== undefined && updates.decimals !== existing.decimals) {
      const shipmentCount = await this.prisma.shipment.count({
        where: { tokenAddress: normalized },
      });

      if (shipmentCount > 0) {
        throw new ConflictException(
          `Cannot change decimals for token ${normalized} because shipments already reference it`,
        );
      }
    }

    const next = {
      ...existing,
      ...(updates.symbol ? { symbol: updates.symbol } : {}),
      ...(updates.decimals !== undefined ? { decimals: updates.decimals } : {}),
      ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
      ...(updates.displayName !== undefined ? { displayName: updates.displayName } : {}),
    };

    this.registry.set(normalized, next);
    await this.redis.del('token_registry:list');

    await this.auditLog.record({
      actorAddress: 'system',
      action: 'TOKEN_REGISTRY_UPDATED',
      resourceType: 'TokenRegistry',
      resourceId: normalized,
      metadata: { before: existing, after: next },
    });

    this.logger.log(`Updated token registry entry ${normalized}`);
    return { address: normalized, ...next };
  }
}
