import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import { BASE_FEE, FeeBumpTransaction, Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { RedisService } from '../../common/redis/redis.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { SPONSORED_FEES_COUNTER } from '../../common/metrics/metric-names';

const DAY_SECONDS = 86_400;

/**
 * Wraps user-signed transactions in a fee-bump paid by the platform sponsor
 * account (FEE_SPONSOR_SECRET_KEY), enforcing a per-user daily cap
 * (FEE_SPONSOR_DAILY_CAP_STROOPS). The secret key is held only as a Keypair
 * and is never logged or returned.
 */
@Injectable()
export class FeeSponsorService {
  private readonly keypair: Keypair | null;
  private readonly dailyCap: number;

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
    private readonly stellar: StellarService,
    @InjectMetric(SPONSORED_FEES_COUNTER) private readonly sponsoredFees: Counter<string>,
  ) {
    const secret = config.get<string>('FEE_SPONSOR_SECRET_KEY');
    this.keypair = secret ? Keypair.fromSecret(secret) : null;
    this.dailyCap = Number(config.get('FEE_SPONSOR_DAILY_CAP_STROOPS') ?? 10_000_000);
  }

  get enabled(): boolean {
    return this.keypair !== null;
  }

  /** Builds and signs a fee-bump around `inner`, reserving its fee against the caller's daily cap. */
  async sponsor(inner: Transaction, userId: string): Promise<{ tx: FeeBumpTransaction; fee: number; release: () => Promise<void> }> {
    if (!this.keypair) throw new ServiceUnavailableException('Fee sponsorship is not configured');

    const ops = inner.operations.length;
    const baseFee = Math.max(Number(BASE_FEE), Math.ceil(Number(inner.fee) / ops));
    const fee = baseFee * (ops + 1);

    const day = new Date().toISOString().slice(0, 10);
    const userKey = `chain:sponsor:user:${userId}:${day}`;
    const client = this.redis.getClient();
    const used = await client.incrby(userKey, fee);
    await client.expire(userKey, DAY_SECONDS * 2);
    if (used > this.dailyCap) {
      await client.decrby(userKey, fee);
      throw new ForbiddenException('Daily fee sponsorship cap reached');
    }

    const tx = TransactionBuilder.buildFeeBumpTransaction(
      this.keypair,
      String(baseFee),
      inner,
      this.stellar.getNetworkPassphrase(),
    );
    tx.sign(this.keypair);

    return {
      tx,
      fee,
      release: async () => {
        await client.decrby(userKey, fee);
      },
    };
  }

  /** Records a successfully submitted sponsored fee for reporting. */
  async record(userId: string, fee: number): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const client = this.redis.getClient();
    await client
      .multi()
      .hincrby(`chain:sponsor:report:${day}`, 'totalFeeStroops', fee)
      .hincrby(`chain:sponsor:report:${day}`, 'txCount', 1)
      .hincrby(`chain:sponsor:report:${day}:users`, userId, fee)
      .expire(`chain:sponsor:report:${day}`, DAY_SECONDS * 90)
      .expire(`chain:sponsor:report:${day}:users`, DAY_SECONDS * 90)
      .exec();
    this.sponsoredFees.inc(fee);
  }

  /** Daily sponsorship report (total fees, tx count, per-user fees). */
  async report(day = new Date().toISOString().slice(0, 10)) {
    const client = this.redis.getClient();
    const [totals, users] = await Promise.all([
      client.hgetall(`chain:sponsor:report:${day}`),
      client.hgetall(`chain:sponsor:report:${day}:users`),
    ]);
    return {
      day,
      totalFeeStroops: Number(totals.totalFeeStroops ?? 0),
      txCount: Number(totals.txCount ?? 0),
      perUser: Object.fromEntries(Object.entries(users).map(([k, v]) => [k, Number(v)])),
    };
  }
}
