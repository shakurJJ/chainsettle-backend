import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Networks,
  SorobanRpc,
  Horizon,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { SpanKind } from '@opentelemetry/api';
import { withSpan } from '../tracing/trace.helper';

/**
 * StellarService
 *
 * Provides:
 *  - RPC client for querying the Stellar network
 *  - Contract interaction helpers (invoke, query)
 *  - Event fetching from a specific ledger range
 *  - Utility methods for address/amount conversion
 *
 * This service does NOT hold any user funds. The backend Stellar keypair
 * is only used for read-only RPC calls and transaction sponsoring
 * (if implemented). All write operations that move funds are signed
 * by the user's wallet (Freighter) in the frontend.
 */
@Injectable()
export class StellarService implements OnModuleInit {
  private readonly logger = new Logger(StellarService.name);

  private rpcClient: SorobanRpc.Server;
   private horizonClient: Horizon.Server;
  private network: string;
  private networkPassphrase: string;
  private contractId: string;

  constructor(private readonly config: ConfigService) {}

onModuleInit() {
    const rpcUrl = this.config.get<string>('STELLAR_RPC_URL');
    const horizonUrl = this.config.get<string>('STELLAR_HORIZON_URL');
    const networkName = this.config.get<string>('STELLAR_NETWORK', 'testnet');

    this.rpcClient = new SorobanRpc.Server(rpcUrl, { allowHttp: true });
    this.horizonClient = new Horizon.Server(horizonUrl, { allowHttp: true });
    this.contractId = this.config.get<string>('CHAINSETTTLE_CONTRACT_ID');

    this.networkPassphrase =
      networkName === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

    this.logger.log(`Stellar connected to ${networkName} (${rpcUrl})`);
    this.logger.log(`Horizon connected at ${horizonUrl}`);
    this.logger.log(`Contract ID: ${this.contractId}`);
  }

  // ----------------------------------------------------------
  // RPC CLIENT ACCESS
  // ----------------------------------------------------------

  getClient(): SorobanRpc.Server {
    return this.rpcClient;
  }

  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  getContractId(): string {
    return this.contractId;
  }

  // ----------------------------------------------------------
  // FETCH CONTRACT EVENTS
  // ----------------------------------------------------------

  /**
   * Fetches contract events from Stellar RPC for a given ledger range.
   * Used by the EventsService poller to detect on-chain state changes.
   *
   * @param startLedger - The ledger to start scanning from
   * @param filters     - Optional array of event topic filters (event names)
   * @returns Array of raw SorobanRpc events
   */
  async fetchContractEvents(
    startLedger: number,
    filters: string[] = [],
  ): Promise<SorobanRpc.Api.EventResponse[]> {
    return withSpan(
      'stellar.fetchContractEvents',
      async (span) => {
        span.setAttribute('stellar.start_ledger', startLedger);
        span.setAttribute('stellar.contract_id', this.contractId);
        if (filters.length > 0) {
          span.setAttribute('stellar.event_filters', filters.join(','));
        }

        try {
          const topicFilters = filters.length > 0
            ? filters.map((f) => [f])
            : undefined;

          const result = await this.rpcClient.getEvents({
            startLedger,
            filters: [
              {
                type: 'contract',
                contractIds: [this.contractId],
                ...(topicFilters && { topics: topicFilters }),
              },
            ],
            limit: 100,
          });

          const events = result.events ?? [];
          span.setAttribute('stellar.event_count', events.length);
          return events;
        } catch (error) {
          this.logger.error(`Failed to fetch events from ledger ${startLedger}`, error.message);
          return [];
        }
      },
      { 'stellar.rpc_url': this.config.get<string>('STELLAR_RPC_URL', '') },
      SpanKind.CLIENT,
    );
  }

  // ----------------------------------------------------------
  // READ CONTRACT STATE (simulation — no gas cost)
  // ----------------------------------------------------------

  /**
   * Simulates a read-only contract call (e.g. get_shipment, get_escrow_balance).
   * Does not submit a transaction — just simulates and returns the result.
   *
   * @param method    - Contract function name
   * @param args      - Array of ScVal arguments
   * @returns Decoded native JS value from the contract
   */
  async simulateContractCall(method: string, args: xdr.ScVal[]): Promise<any> {
    return withSpan(
      'stellar.simulateContractCall',
      async (span) => {
        span.setAttribute('stellar.contract_method', method);
        span.setAttribute('stellar.contract_id', this.contractId);

        try {
          const contract = new Contract(this.contractId);

          const dummyKeypair = Keypair.random();
          const dummyAccount = await this.rpcClient.getAccount(dummyKeypair.publicKey()).catch(() => ({
            accountId: () => dummyKeypair.publicKey(),
            sequenceNumber: () => '0',
            incrementSequenceNumber: () => {},
          }));

          const tx = new TransactionBuilder(dummyAccount as any, {
            fee: BASE_FEE,
            networkPassphrase: this.networkPassphrase,
          })
            .addOperation(contract.call(method, ...args))
            .setTimeout(30)
            .build();

          const simulation = await this.rpcClient.simulateTransaction(tx);

          if (SorobanRpc.Api.isSimulationError(simulation)) {
            throw new Error(`Contract simulation error: ${simulation.error}`);
          }

          if (SorobanRpc.Api.isSimulationSuccess(simulation) && simulation.result) {
            return scValToNative(simulation.result.retval);
          }

          return null;
        } catch (error) {
          this.logger.error(`simulateContractCall(${method}) failed`, error.message);
          throw error;
        }
      },
      { 'stellar.rpc_url': this.config.get<string>('STELLAR_RPC_URL', '') },
      SpanKind.CLIENT,
    );
  }

  // ----------------------------------------------------------
  // UTILITIES
  // ----------------------------------------------------------

  /**
   * Converts a token amount from its smallest on-chain unit to a human-readable
   * decimal string using the given decimal precision.
   *
   * @example toHumanAmount(10_000_000n, 7) → "1.0000000"  (USDC/EURC — 7 dp)
   * @example toHumanAmount(1_000_000n,  6) → "1.000000"   (6-decimal token)
   */
  toHumanAmount(amount: bigint | string, decimals = 7): string {
    const value = BigInt(amount);
    const divisor = BigInt(10 ** decimals);
    const whole = value / divisor;
    const fraction = (value % divisor).toString().padStart(decimals, '0');
    return `${whole}.${fraction}`;
  }

  /**
   * Converts a human-readable token amount to its smallest on-chain unit.
   *
   * @example toBaseUnit("1.5", 7) → 15_000_000n
   * @example toBaseUnit("1.5", 6) →  1_500_000n
   */
  toBaseUnit(amount: string, decimals = 7): bigint {
    const [whole, fraction = ''] = amount.split('.');
    const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
    return BigInt(whole) * BigInt(10 ** decimals) + BigInt(paddedFraction);
  }

  /** @deprecated Use toHumanAmount(amount, 7) */
  stroopsToUsdc(stroops: bigint | string): string {
    return this.toHumanAmount(stroops, 7);
  }

  /** @deprecated Use toBaseUnit(amount, 7) */
  usdcToStroops(usdc: string): bigint {
    return this.toBaseUnit(usdc, 7);
  }

  /**
   * Returns the current ledger sequence number from the network.
   * Used by the event poller to know where to start scanning.
   */
  async getLatestLedger(): Promise<number> {
    const info = await this.rpcClient.getLatestLedger();
    return info.sequence;
  }

  /**
   * Fetches metadata for a specific ledger sequence number via the Stellar RPC.
   * Returns { sequence, closedAt, txCount, baseFee } or null if not found.
   */
  async getLedger(sequence: number): Promise<{ sequence: number; closedAt: string; txCount: number; baseFee: number } | null> {
    try {
      const result = await (this.rpcClient as any).getLedger({ ledgerSeq: sequence });
      if (!result) return null;
      return {
        sequence: result.sequence ?? sequence,
        closedAt: result.closedAt ?? result.closed_at ?? '',
        txCount: result.txCount ?? result.tx_count ?? 0,
        baseFee: result.baseFee ?? result.base_fee ?? 0,
      };
    } catch (error) {
      this.logger.error(`getLedger(${sequence}) failed`, error.message);
      return null;
    }
  }

  // ----------------------------------------------------------
  // ACCOUNT LOOKUP (balance + trustlines)
  // ----------------------------------------------------------

  /**
   * Fetches an account's XLM balance and trustlines via Horizon.
   * Returns null if the account doesn't exist on-chain (unfunded address) —
   * the caller is expected to translate that into a 404.
   */
  async getAccountInfo(address: string): Promise<{
    address: string;
    xlmBalance: string;
    trustlines: { asset: string; balance: string; limit: string }[];
  } | null> {
    try {
      const account = await this.horizonClient.loadAccount(address);

      const native = account.balances.find(
        (b) => b.asset_type === 'native',
      );

      const trustlines = account.balances
        .filter((b) => b.asset_type !== 'native')
        .map((b) => ({
          asset:
            'asset_code' in b && 'asset_issuer' in b
              ? `${b.asset_code}:${b.asset_issuer}`
              : b.asset_type,
          balance: b.balance,
          limit: 'limit' in b ? b.limit : '0',
        }));

      return {
        address,
        xlmBalance: native?.balance ?? '0',
        trustlines,
      };
    } catch (error) {
      if (error?.response?.status === 404) {
        return null;
      }
      this.logger.error(`getAccountInfo(${address}) failed`, error.message);
      throw error;
    }
  }
  // ----------------------------------------------------------
  // NETWORK STATUS SNAPSHOT
  // ----------------------------------------------------------

  /**
   * Lightweight current-state snapshot for a status indicator / ops dashboard.
   * Distinct from /health (DB + Redis focused) — this is purely RPC-facing
   * and must never throw; a downstream RPC outage degrades to
   * `rpcHealthy: false` rather than surfacing a 500.
   */
  async getNetworkStatus(): Promise<{
    latestLedger: number | null;
    networkPassphrase: string;
    rpcHealthy: boolean;
    rpcLatencyMs: number;
  }> {
    const startedAt = Date.now();

    try {
      await this.rpcClient.getHealth();
      const latest = await this.rpcClient.getLatestLedger();

      return {
        latestLedger: latest.sequence,
        networkPassphrase: this.networkPassphrase,
        rpcHealthy: true,
        rpcLatencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.logger.warn(`getNetworkStatus RPC check failed: ${error.message}`);
      return {
        latestLedger: null,
        networkPassphrase: this.networkPassphrase,
        rpcHealthy: false,
        rpcLatencyMs: Date.now() - startedAt,
      };
    }
  }

  // ----------------------------------------------------------
  // CONTRACT EXISTENCE CHECK
  // ----------------------------------------------------------

  /**
   * Checks whether a Soroban contract is actually deployed at the given
   * address, by reading its ledger-key-instance entry via getContractData.
   * getContractData rejects when the entry isn't found, which is how we
   * distinguish "no contract here" from a real RPC failure.
   */
  async contractExists(contractAddress: string): Promise<boolean> {
    try {
      await this.rpcClient.getContractData(
        contractAddress,
        xdr.ScVal.scvLedgerKeyContractInstance(),
        SorobanRpc.Durability.Persistent,
      );
      return true;
    } catch (error) {
      if (error?.message?.toLowerCase().includes('not found')) {
        return false;
      }
      this.logger.error(`contractExists(${contractAddress}) failed`, error.message);
      throw error;
    }
  }

  // ----------------------------------------------------------
  // STREAMING SUBSCRIPTION
  // ----------------------------------------------------------

  /**
   * Subscribes to contract events using a tight polling loop (1-second interval)
   * that approximates real-time streaming from the Soroban RPC.
   *
   * @param startLedger - Ledger to begin scanning from
   * @param onEvent     - Called for each new event in order
   * @param onError     - Called when the loop encounters an RPC error
   * @returns           - Unsubscribe function; call it to stop the loop
   */
  subscribeToContractEvents(
    startLedger: number,
    onEvent: (event: SorobanRpc.Api.EventResponse) => Promise<void>,
    onError: (error: Error) => void,
  ): () => void {
    let active = true;
    let currentLedger = startLedger;

    const loop = async () => {
      while (active) {
        try {
          const events = await this.fetchContractEvents(currentLedger);
          for (const event of events) {
            if (!active) return;
            await onEvent(event);
            currentLedger = Math.max(currentLedger, event.ledger + 1);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        } catch (err) {
          if (active) {
            onError(err as Error);
          }
          return;
        }
      }
    };

    void loop();
    return () => {
      active = false;
    };
  }
}
