import {
  BadRequestException,
  Injectable,
  Logger,
  InternalServerErrorException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import axios from 'axios';
import * as FormData from 'form-data';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';

export interface IpfsUploadLimits {
  maxSizeBytes: number;
  allowedMimeTypes: string[];
}

const APP_CONFIG_KEY = 'ipfs_upload_limits';
const UPLOAD_LIMITS_CACHE_TTL_MS = 60_000;

const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024;

const DEFAULT_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
];

/**
 * IpfsService
 *
 * Uploads files to IPFS via Pinata's pinning API.
 * Falls back gracefully if keys are not configured (useful in development).
 *
 * Environment variables:
 *   IPFS_GATEWAY_URL               — Public read gateway, e.g. https://gateway.pinata.cloud/ipfs
 *   IPFS_API_KEY                   — Pinata API key (JWT or v2 key)
 *   IPFS_HEALTH_CHECK_INTERVAL_MS  — How often to re-check IPFS connectivity (default 60000ms)
 *   IPFS_MAX_UPLOAD_SIZE_BYTES     — Default max upload size in bytes, used when no admin
 *                                    override is configured in AppConfig (default 50MB)
 *   IPFS_ALLOWED_MIME_TYPES        — Comma-separated default allowed MIME types, used when
 *                                    no admin override is configured in AppConfig
 */
@Injectable()
export class IpfsService implements OnModuleInit {
  private readonly logger = new Logger(IpfsService.name);
  private readonly pinataUrl = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
  private readonly pinataTestUrl = 'https://api.pinata.cloud/data/testAuthentication';
  private readonly gateway: string;
  private readonly apiKey: string;
  private readonly healthCheckInterval: number;
  private readonly defaultUploadLimits: IpfsUploadLimits;

  private cachedUploadLimits: IpfsUploadLimits | null = null;
  private cachedUploadLimitsAt = 0;

  isHealthy = false;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {
    this.gateway = this.config.get<string>(
      'IPFS_GATEWAY_URL',
      'https://gateway.pinata.cloud/ipfs',
    );
    this.apiKey = this.config.get<string>('IPFS_API_KEY', '');
    this.healthCheckInterval = this.config.get<number>('IPFS_HEALTH_CHECK_INTERVAL_MS', 60_000);

    const mimeTypesEnv = this.config.get<string>('IPFS_ALLOWED_MIME_TYPES');
    this.defaultUploadLimits = {
      maxSizeBytes: this.config.get<number>('IPFS_MAX_UPLOAD_SIZE_BYTES', DEFAULT_MAX_SIZE_BYTES),
      allowedMimeTypes: mimeTypesEnv
        ? mimeTypesEnv.split(',').map((t) => t.trim()).filter(Boolean)
        : DEFAULT_ALLOWED_MIME_TYPES,
    };
  }

  async onModuleInit() {
    if (process.env.SDK_GENERATE === '1') {
      this.isHealthy = true;
      return;
    }
    await this.checkConnectivity();

    if (this.healthCheckInterval > 0) {
      setInterval(() => this.checkConnectivity(), this.healthCheckInterval);
    }
  }

  async checkConnectivity(): Promise<void> {
    if (!this.apiKey) {
      // Dev mode — no API key configured, treat as healthy to allow stub uploads
      this.isHealthy = true;
      return;
    }

    try {
      await axios.get(this.pinataTestUrl, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeout: 5_000,
      });
      this.isHealthy = true;
      this.logger.log('IPFS node reachable');
    } catch (error) {
      this.isHealthy = false;
      this.logger.error(`IPFS node unreachable: ${error.message}`);
    }
  }

  /**
   * Uploads a file buffer to IPFS via Pinata.
   *
   * @param fileBuffer  - Raw file bytes
   * @param originalName - Original filename (for Pinata metadata)
   * @param mimeType    - MIME type of the file
   * @returns The IPFS CID (v1, base32 encoded)
   * @throws ServiceUnavailableException when IPFS node is unreachable
   * @throws InternalServerErrorException on upload failure
   */
  async uploadFile(
    fileBuffer: Buffer,
    originalName: string,
    mimeType: string,
  ): Promise<string> {
    const limits = await this.getUploadLimits();

    if (fileBuffer.length > limits.maxSizeBytes) {
      throw new BadRequestException(
        `File size ${fileBuffer.length} bytes exceeds the maximum allowed size of ${limits.maxSizeBytes} bytes`,
      );
    }

    if (!limits.allowedMimeTypes.includes(mimeType)) {
      throw new BadRequestException(
        `Unsupported file type: ${mimeType}. Allowed types: ${limits.allowedMimeTypes.join(', ')}`,
      );
    }

    const hash = createHash('sha256').update(fileBuffer).digest('hex');
    const dedupKey = `ipfs:dedup:${hash}`;
    const cached = await this.redis.get(dedupKey);
    if (cached) {
      this.logger.debug('IPFS dedup hit: returning cached CID');
      return cached;
    }

    if (!this.apiKey) {
      this.logger.warn(
        'IPFS_API_KEY not configured — returning stub CID for development',
      );
      return `bafydev${Buffer.from(originalName).toString('hex').slice(0, 52)}`;
    }

    if (!this.isHealthy) {
      throw new ServiceUnavailableException('IPFS service is currently unavailable');
    }

    try {
      const form = new FormData();
      form.append('file', fileBuffer, {
        filename: originalName,
        contentType: mimeType,
      });

      const pinataMetadata = JSON.stringify({ name: originalName });
      form.append('pinataMetadata', pinataMetadata);

      const response = await axios.post<{ IpfsHash: string }>(
        this.pinataUrl,
        form,
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...form.getHeaders(),
          },
          maxBodyLength: Infinity,
          timeout: 60_000,
        },
      );

      const cid = response.data.IpfsHash;
      this.logger.log(`File pinned to IPFS: ${cid} (${originalName})`);
      const ttlDays = this.config.get<number>('IPFS_DEDUP_TTL_DAYS', 30);
      await this.redis.set(dedupKey, cid, ttlDays * 86400);
      return cid;
    } catch (error) {
      const detail = error.response?.data?.error?.details ?? error.message;
      this.logger.error(`Failed to pin file to IPFS`, detail);
      throw new InternalServerErrorException(
        `IPFS upload failed: ${detail}`,
      );
    }
  }

  /**
   * Returns the full public gateway URL for a given CID.
   *
   * @example getGatewayUrl('bafybeig...') → 'https://gateway.pinata.cloud/ipfs/bafybeig...'
   */
  getGatewayUrl(cid: string): string {
    return `${this.gateway}/${cid}`;
  }

  // ----------------------------------------------------------
  // UPLOAD LIMITS — admin-configurable via AppConfig, with an
  // in-memory cache to avoid a DB hit on every upload.
  // ----------------------------------------------------------

  /**
   * Returns the currently effective upload limits (max size + allowed MIME
   * types). Reads from AppConfig, cached in memory for
   * UPLOAD_LIMITS_CACHE_TTL_MS. Falls back to env-var-derived defaults when
   * no AppConfig row exists (or the DB read fails).
   */
  async getUploadLimits(): Promise<IpfsUploadLimits> {
    const now = Date.now();
    if (this.cachedUploadLimits && now - this.cachedUploadLimitsAt < UPLOAD_LIMITS_CACHE_TTL_MS) {
      return this.cachedUploadLimits;
    }

    let limits = this.defaultUploadLimits;
    try {
      const row = await this.prisma.appConfig.findUnique({ where: { key: APP_CONFIG_KEY } });
      if (row?.value) {
        const value = row.value as Partial<IpfsUploadLimits>;
        limits = {
          maxSizeBytes:
            typeof value.maxSizeBytes === 'number'
              ? value.maxSizeBytes
              : this.defaultUploadLimits.maxSizeBytes,
          allowedMimeTypes:
            Array.isArray(value.allowedMimeTypes) && value.allowedMimeTypes.length > 0
              ? value.allowedMimeTypes
              : this.defaultUploadLimits.allowedMimeTypes,
        };
      }
    } catch (error) {
      this.logger.warn(
        `Failed to load IPFS upload limits from AppConfig, using defaults: ${error.message}`,
      );
    }

    this.cachedUploadLimits = limits;
    this.cachedUploadLimitsAt = now;
    return limits;
  }

  /**
   * Persists an admin override for the upload limits. Unspecified fields
   * keep their current effective value. Updates the in-memory cache
   * immediately so the new limits apply to the very next upload.
   */
  async updateUploadLimits(update: {
    maxSizeBytes?: number;
    allowedMimeTypes?: string[];
  }): Promise<IpfsUploadLimits> {
    const current = await this.getUploadLimits();
    const next: IpfsUploadLimits = {
      maxSizeBytes: update.maxSizeBytes ?? current.maxSizeBytes,
      allowedMimeTypes: update.allowedMimeTypes ?? current.allowedMimeTypes,
    };

    await this.prisma.appConfig.upsert({
      where: { key: APP_CONFIG_KEY },
      create: { key: APP_CONFIG_KEY, value: next as any },
      update: { value: next as any },
    });

    this.cachedUploadLimits = next;
    this.cachedUploadLimitsAt = Date.now();
    return next;
  }

  /**
   * Checks whether a CID is pinned/available without downloading its content.
   * Issues a HEAD request against the same gateway used by getFile(), so a
   * true result here means getFile() would succeed too.
   *
   * @param cid - IPFS CID to check
   * @returns { cid, pinned, sizeBytes? } — sizeBytes omitted if the gateway
   *          doesn't report a Content-Length header
   * @throws InternalServerErrorException on unexpected (non-404) failures
   */
  async checkPinStatus(cid: string): Promise<{ cid: string; pinned: boolean; sizeBytes?: number }> {
    if (!this.apiKey) {
      this.logger.warn(
        'IPFS_API_KEY not configured — cannot check pin status in development',
      );
      return { cid, pinned: false };
    }

    try {
      const response = await axios.head(`${this.gateway}/${cid}`, { timeout: 10_000 });
      const lengthHeader = response.headers['content-length'];
      const sizeBytes = lengthHeader !== undefined ? Number(lengthHeader) : undefined;

      return {
        cid,
        pinned: true,
        ...(sizeBytes !== undefined && !Number.isNaN(sizeBytes) ? { sizeBytes } : {}),
      };
    } catch (error) {
      const status = error.response?.status;
      if (status && status >= 400 && status < 500) {
        return { cid, pinned: false };
      }

      const detail = error.response?.data?.error?.details ?? error.message;
      this.logger.error(`Failed to check IPFS pin status for ${cid}`, detail);
      throw new InternalServerErrorException(`IPFS pin status check failed: ${detail}`);
    }
  }

  /**
   * Fetches a file from IPFS by CID and returns its buffer and MIME type.
   *
   * @param cid - IPFS CID of the file
   * @returns { buffer, mimeType }
   * @throws InternalServerErrorException on fetch failure
   */
  async getFile(cid: string): Promise<{ buffer: Buffer; mimeType: string }> {
    if (!this.apiKey) {
      this.logger.warn(
        'IPFS_API_KEY not configured — returning empty buffer for development',
      );
      return { buffer: Buffer.alloc(0), mimeType: 'application/octet-stream' };
    }

    try {
      const response = await axios.get(`${this.gateway}/${cid}`, {
        responseType: 'arraybuffer',
        timeout: 60_000,
      });

      this.logger.log(`File fetched from IPFS: ${cid}`);
      return {
        buffer: Buffer.from(response.data),
        mimeType:
          (response.headers['content-type'] as string | undefined) ??
          'application/octet-stream',
      };
    } catch (error) {
      const detail = error.response?.data?.error?.details ?? error.message;
      this.logger.error(`Failed to fetch file from IPFS`, detail);
      throw new InternalServerErrorException(
        `IPFS fetch failed: ${detail}`,
      );
    }
  }
}
