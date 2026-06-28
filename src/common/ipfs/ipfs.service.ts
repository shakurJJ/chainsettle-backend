import {
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
 */
@Injectable()
export class IpfsService implements OnModuleInit {
  private readonly logger = new Logger(IpfsService.name);
  private readonly pinataUrl = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
  private readonly pinataTestUrl = 'https://api.pinata.cloud/data/testAuthentication';
  private readonly gateway: string;
  private readonly apiKey: string;
  private readonly healthCheckInterval: number;

  isHealthy = false;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.gateway = this.config.get<string>(
      'IPFS_GATEWAY_URL',
      'https://gateway.pinata.cloud/ipfs',
    );
    this.apiKey = this.config.get<string>('IPFS_API_KEY', '');
    this.healthCheckInterval = this.config.get<number>('IPFS_HEALTH_CHECK_INTERVAL_MS', 60_000);
  }

  async onModuleInit() {
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
