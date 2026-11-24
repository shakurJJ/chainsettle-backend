import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Gauge } from 'prom-client';
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { NotificationType } from '@prisma/client';
import { StellarService } from '../../common/stellar/stellar.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CONTRACT_TTL_GAUGE } from '../../common/metrics/metric-names';

const RPC_BATCH = 200;

/**
 * Periodically reads the live-until ledger of the contract instance and of
 * every ACTIVE shipment's persistent entry, exports the remaining ledgers as
 * `chainsettle_contract_ttl_ledgers_remaining{entry}` and alerts admins when
 * an entry is below CONTRACT_TTL_ALERT_THRESHOLD_LEDGERS. See
 * docs/runbooks/contract-ttl.md for the extend-TTL procedure.
 */
@Injectable()
export class ContractTtlMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractTtlMonitorService.name);
  private timer?: NodeJS.Timeout;
  private readonly alerted = new Set<string>();

  constructor(
    @InjectMetric(CONTRACT_TTL_GAUGE) private readonly gauge: Gauge<string>,
    private readonly stellar: StellarService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  get threshold(): number {
    return Number(this.config.get('CONTRACT_TTL_ALERT_THRESHOLD_LEDGERS') ?? 120_960); // ~7 days
  }

  onModuleInit() {
    const interval = Number(this.config.get('CONTRACT_TTL_CHECK_INTERVAL_MS') ?? 3_600_000);
    this.timer = setInterval(() => void this.check(), interval);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async check(): Promise<{ entry: string; remaining: number }[]> {
    const contractId = this.stellar.getContractId();
    const contract = new Address(contractId).toScAddress();
    const keys = new Map<string, xdr.LedgerKey>();
    const dataKey = (key: xdr.ScVal) =>
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({ contract, key, durability: xdr.ContractDataDurability.persistent() }),
      );

    keys.set('instance', dataKey(xdr.ScVal.scvLedgerKeyContractInstance()));
    const shipments = await this.prisma.shipment.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
    for (const { id } of shipments) {
      keys.set(`shipment:${id}`, dataKey(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Shipment'), nativeToScVal(id, { type: 'string' })])));
    }

    const results: { entry: string; remaining: number }[] = [];
    try {
      const rpc = this.stellar.getClient();
      const names = [...keys.keys()];
      for (let i = 0; i < names.length; i += RPC_BATCH) {
        const batch = names.slice(i, i + RPC_BATCH);
        const res = await rpc.getLedgerEntries(...batch.map((n) => keys.get(n)!));
        const byKey = new Map(res.entries.map((e) => [e.key.toXDR('base64'), e.liveUntilLedgerSeq]));
        for (const name of batch) {
          const liveUntil = byKey.get(keys.get(name)!.toXDR('base64'));
          if (liveUntil === undefined) continue;
          results.push({ entry: name, remaining: liveUntil - res.latestLedger });
        }
      }
    } catch (err) {
      this.logger.warn(`Contract TTL check failed: ${(err as Error).message}`);
      return results;
    }

    this.gauge.reset();
    for (const r of results) {
      this.gauge.set({ entry: r.entry }, r.remaining);
      if (r.remaining < this.threshold) await this.alert(r.entry, r.remaining);
      else this.alerted.delete(r.entry);
    }
    return results;
  }

  private async alert(entry: string, remaining: number) {
    this.logger.error(`Contract storage entry "${entry}" has ${remaining} ledgers left before archival`);
    if (this.alerted.has(entry)) return;
    this.alerted.add(entry);
    const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN' }, select: { stellarAddress: true } });
    for (const admin of admins) {
      await this.notifications.notifyUser(
        admin.stellarAddress,
        NotificationType.SYSTEM_ALERT,
        'Contract storage TTL low',
        `Entry "${entry}" will be archived in ${remaining} ledgers (threshold ${this.threshold}). Extend its TTL — see docs/runbooks/contract-ttl.md.`,
        { entry, remaining },
      );
    }
  }
}
