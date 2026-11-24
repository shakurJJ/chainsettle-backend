import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
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
  StrKey,
} from '@stellar/stellar-sdk';
import { SpanKind } from '@opentelemetry/api';
import { withSpan } from '../tracing/trace.helper';
import { MetricsService } from '../metrics/metrics.service';
import { RpcPool, parseUrlList } from './rpc-pool';

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
export class StellarService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StellarService.name);

  private rpcPool: RpcPool<SorobanRpc.Server>;
  private horizonPool: RpcPool<Horizon.Server>;
  private healthTimer?: NodeJS.Timeout;
  private network: string;
  private networkPassphrase: string;
  private contractId: string;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /** Active (failover-aware) Soroban RPC client. */
  private get rpcClient(): SorobanRpc.Server {
    return this.rpcPool.proxy;
  }

  /** Active (failover-aware) Horizon client. */
  private get horizonClient(): Horizon.Server {
    return this.horizonPool.proxy;
  }

  /**
   * NestJS lifecycle hook. Builds the failover-aware RPC and Horizon client
   * pools from configuration, verifies each endpoint's network passphrase,
   * and starts the periodic endpoint-health probe loop.
   *
   * Reads `STELLAR_RPC_URLS`/`STELLAR_RPC_URL`, `STELLAR_HORIZON_URLS`/
   * `STELLAR_HORIZON_URL`, `STELLAR_NETWORK` and `CHAINSETTTLE_CONTRACT_ID`.
   *
   * @remarks Hits both Soroban RPC (`getNetwork`, `getLatestLedger`) and
   * Horizon (root endpoint) once per configured endpoint during the initial
   * health probe. Throws if the RPC or Horizon pool is constructed without
   * any configured URL.
   */
  onModuleInit() {
    const rpcUrls = parseUrlList(
      this.config.get<string>('STELLAR_RPC_URLS'),
      this.config.get<string>('STELLAR_RPC_URL'),
    );
    const horizonUrls = parseUrlList(
      this.config.get<string>('STELLAR_HORIZON_URLS'),
      this.config.get<string>('STELLAR_HORIZON_URL'),
    );
    const networkName = this.config.get<string>('STELLAR_NETWORK', 'testnet');

    this.contractId = this.config.get<string>('CHAINSETTTLE_CONTRACT_ID');
    this.networkPassphrase =
      networkName === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

    const passphrase = this.networkPassphrase;
    this.rpcPool = new RpcPool(rpcUrls, (url) => new SorobanRpc.Server(url, { allowHttp: true }), {
      name: 'rpc',
      probe: async (client, url) => {
        const network = await client.getNetwork();
        if (network.passphrase !== passphrase) {
          throw new Error(`Network passphrase mismatch for ${url}`);
        }
        return (await client.getLatestLedger()).sequence;
      },
    });
    this.horizonPool = new RpcPool(horizonUrls, (url) => new Horizon.Server(url, { allowHttp: true }), {
      name: 'horizon',
      probe: async (_client, url) => {
        const res = await fetch(url);
        if (!res.ok) throw Object.assign(new Error(`Horizon returned ${res.status}`), { status: res.status });
        const root: any = await res.json();
        if (root.network_passphrase !== passphrase) {
          throw new Error(`Network passphrase mismatch for ${url}`);
        }
        return Number(root.history_latest_ledger ?? root.core_latest_ledger ?? 0);
      },
    });

    const intervalMs = Number(this.config.get('STELLAR_HEALTH_INTERVAL_MS', 15_000));
    void this.refreshEndpointHealth();
    this.healthTimer = setInterval(() => void this.refreshEndpointHealth(), intervalMs);
    this.healthTimer.unref?.();

    this.logger.log(`Stellar connected to ${networkName} (${rpcUrls.join(', ')})`);
    this.logger.log(`Horizon connected at ${horizonUrls.join(', ')}`);
    this.logger.log(`Contract ID: ${this.contractId}`);
  }

  /**
   * NestJS lifecycle hook. Stops the periodic endpoint-health probe timer.
   *
   * @remarks Does not make any network calls.
   */
  onModuleDestroy() {
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  /**
   * Probes all configured Soroban RPC and Horizon endpoints and publishes
   * their health (and active status) as OpenTelemetry/Prometheus metrics.
   *
   * @returns Resolves once every endpoint has been probed and metrics updated.
   *
   * @remarks Hits Soroban RPC (`getNetwork`, `getLatestLedger`) and Horizon
   * (root endpoint) once per configured endpoint. Individual probe failures
   * are recorded as unhealthy endpoints rather than thrown.
   */
  async refreshEndpointHealth(): Promise<void> {
    await Promise.all([this.rpcPool.healthCheck(), this.horizonPool.healthCheck()]);
    for (const [type, pool] of [['rpc', this.rpcPool], ['horizon', this.horizonPool]] as const) {
      for (const ep of pool.status()) {
        this.metrics?.setStellarEndpointHealth(type, ep.url, ep.healthy, ep.active);
      }
    }
  }

  /**
   * Returns the currently active endpoint URL and per-endpoint health details
   * for both the Soroban RPC and Horizon pools.
   *
   * @returns Snapshot shaped for `GET /health/detailed`:
   * `{ rpc: { active, endpoints }, horizon: { active, endpoints } }`, where
   * each `endpoints` entry includes url, healthy, active, latencyMs,
   * latestLedger, consecutiveFailures, circuitOpenUntil and lastError.
   *
   * @remarks Pure in-memory read of cached pool state — makes no network calls.
   */
  getEndpointHealth() {
    return {
      rpc: { active: this.rpcPool.activeUrl, endpoints: this.rpcPool.status() },
      horizon: { active: this.horizonPool.activeUrl, endpoints: this.horizonPool.status() },
    };
  }

  // ----------------------------------------------------------
  // RPC CLIENT ACCESS
  // ----------------------------------------------------------

  /**
   * Returns the failover-aware Soroban RPC client proxy.
   *
   * @returns A `SorobanRpc.Server` proxy that routes each call to the
   * healthiest endpoint and fails over on network/5xx errors.
   *
   * @remarks Returns an in-memory proxy — makes no network calls itself;
   * calls made on the returned client hit Soroban RPC.
   */
  getClient(): SorobanRpc.Server {
    return this.rpcClient;
  }

  /**
   * Returns the Stellar network passphrase the service is configured for.
   *
   * @returns `Networks.PUBLIC` when `STELLAR_NETWORK=mainnet`, otherwise
   * `Networks.TESTNET`.
   *
   * @remarks Pure in-memory read — makes no network calls.
   */
  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  /**
   * Returns the configured ChainSettle Soroban contract address.
   *
   * @returns The contract address from `CHAINSETTTLE_CONTRACT_ID`.
   *
   * @remarks Pure in-memory read — makes no network calls.
   */
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
   * @returns Array of raw SorobanRpc events; an empty array when no events
   * match or when the RPC call fails (errors are logged, not rethrown).
   *
   * @remarks Hits Soroban RPC (`getEvents`). At most 100 events are returned
   * per call, filtered to the configured contract. Callers should poll with
   * `startLedger = lastEvent.ledger + 1` to walk forward.
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
      { 'stellar.rpc_url': this.rpcPool.activeUrl },
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
   * @returns Decoded native JS value from the contract, or `null` when the
   * simulation succeeds but produces no return value.
   *
   * @throws If the RPC reports a simulation error (`Contract simulation
   * error: ...`), or if the RPC/network call itself fails. The error is
   * logged before being rethrown.
   *
   * @remarks Hits Soroban RPC (`getAccount`, `simulateTransaction`). No
   * transaction is submitted and no fee is paid; a throwaway keypair is used
   * purely as the (unsent) simulation source account.
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
      { 'stellar.rpc_url': this.rpcPool.activeUrl },
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
   * @param amount   - Integer amount in the token's smallest unit (stroops-like)
   * @param decimals - Number of decimal places the token uses (default 7, e.g. USDC/EURC)
   * @returns Decimal string with exactly `decimals` fractional digits.
   *
   * @throws `SyntaxError` from `BigInt()` if `amount` is not a valid integer string.
   *
   * @remarks Pure computation — makes no network calls.
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
   * @param amount   - Decimal string, e.g. "1.5". Fractional digits beyond
   * `decimals` are truncated; missing digits are zero-padded.
   * @param decimals - Number of decimal places the token uses (default 7)
   * @returns Integer amount as a `bigint` in the token's smallest unit.
   *
   * @throws `SyntaxError` from `BigInt()` if the whole or fractional part of
   * `amount` is not a valid integer (e.g. "abc.x", "" or "1e6").
   *
   * @remarks Pure computation — makes no network calls.
   *
   * @example toBaseUnit("1.5", 7) → 15_000_000n
   * @example toBaseUnit("1.5", 6) →  1_500_000n
   */
  toBaseUnit(amount: string, decimals = 7): bigint {
    const [whole, fraction = ''] = amount.split('.');
    const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
    return BigInt(whole) * BigInt(10 ** decimals) + BigInt(paddedFraction);
  }

  /**
   * Converts stroops (7-decimal base units) to a human-readable USDC string.
   *
   * @param stroops - Integer amount in the token's smallest unit
   * @returns Decimal string with 7 fractional digits.
   *
   * @throws `SyntaxError` if `stroops` is not a valid integer.
   *
   * @deprecated Use `toHumanAmount(amount, 7)` instead.
   * @remarks Pure computation — makes no network calls.
   */
  stroopsToUsdc(stroops: bigint | string): string {
    return this.toHumanAmount(stroops, 7);
  }

  /**
   * Converts a human-readable USDC amount to stroops (7-decimal base units).
   *
   * @param usdc - Decimal string, e.g. "1.5"
   * @returns Integer amount as a `bigint` in 7-decimal base units.
   *
   * @throws `SyntaxError` if `usdc` is not a valid decimal integer string.
   *
   * @deprecated Use `toBaseUnit(amount, 7)` instead.
   * @remarks Pure computation — makes no network calls.
   */
  usdcToStroops(usdc: string): bigint {
    return this.toBaseUnit(usdc, 7);
  }

  /**
   * Returns the current ledger sequence number from the network.
   * Used by the event poller to know where to start scanning.
   *
   * @returns The latest closed ledger's sequence number.
   *
   * @throws If the Soroban RPC call fails (network/5xx errors after the
   * pool has exhausted all healthy endpoints).
   *
   * @remarks Hits Soroban RPC (`getLatestLedger`).
   */
  async getLatestLedger(): Promise<number> {
    const info = await this.rpcClient.getLatestLedger();
    return info.sequence;
  }

  /**
   * Probes the Soroban RPC retention window by binary-searching for the oldest
   * ledger that `getEvents` can still serve.
   *
   * Strategy: the Stellar RPC rejects `getEvents` calls whose `startLedger`
   * is older than the node's history window with an error containing the phrase
   * "startLedger". We binary-search between 1 and (latestLedger - 1) to find
   * the actual retention floor.  A simpler heuristic is used as the lower bound
   * so the search converges quickly (~7 iterations for a 17-day / ~1.5 M ledger
   * window at 5 s/ledger).
   *
   * @returns The oldest ledger sequence number the connected RPC node can
   * still serve via `getEvents`; `1` if the latest ledger cannot be fetched.
   *
   * @remarks Hits Soroban RPC (`getLatestLedger`, then repeated `getEvents`
   * probes). Never throws — unexpected probe errors abort the search
   * conservatively and return the best answer found so far.
   */
  async getOldestAvailableLedger(): Promise<number> {
    let latest: number;
    try {
      latest = await this.getLatestLedger();
    } catch {
      return 1;
    }

    // A Soroban RPC node typically retains ~17 days ≈ ~288 000 ledgers.
    // Start the binary search a little beyond that as the lower bound.
    let lo = Math.max(1, latest - 400_000);
    let hi = latest - 1;
    let oldest = latest;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      try {
        await this.rpcClient.getEvents({
          startLedger: mid,
          filters: [],
          limit: 1,
        });
        // RPC accepted this ledger → try going even further back
        oldest = mid;
        hi = mid - 1;
      } catch (err) {
        const msg: string = (err as Error).message ?? '';
        if (msg.toLowerCase().includes('startledger') || msg.toLowerCase().includes('not found')) {
          // Too old — move the lower bound up
          lo = mid + 1;
        } else {
          // Unexpected RPC error — bail out conservatively
          this.logger.warn(`getOldestAvailableLedger probe error at ${mid}: ${msg}`);
          break;
        }
      }
    }

    return oldest;
  }

  /**
   * Fetches metadata for a specific ledger sequence number via the Stellar RPC.
   *
   * @param sequence - The ledger sequence number to look up.
   * @returns An object `{ sequence, closedAt, txCount, baseFee }` with
   * snake/camel-case-tolerant field mapping, or `null` if the ledger is not
   * found or the RPC call fails (errors are logged, not rethrown).
   *
   * @remarks Hits Soroban RPC (`getLedger`). Uses a lenient `any` cast on the
   * RPC response because `getLedger` is not present in every SDK version.
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
   *
   * @param address - The Stellar account (G...) address to look up.
   * @returns The account's address, native XLM balance and non-native
   * trustlines (`asset` formatted as `CODE:ISSUER`), or `null` if the
   * account doesn't exist on-chain (unfunded address) — the caller is
   * expected to translate that into a 404.
   *
   * @throws For any Horizon failure other than 404 (network/5xx after the
   * pool has exhausted all healthy endpoints). The error is logged before
   * being rethrown.
   *
   * @remarks Hits Horizon (`loadAccount`).
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
   *
   * @returns `{ latestLedger, networkPassphrase, rpcHealthy, rpcLatencyMs }`;
   * `latestLedger` is `null` when the RPC health/ledger check fails.
   *
   * @remarks Hits Soroban RPC (`getHealth`, `getLatestLedger`). Never throws.
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
   *
   * @param contractAddress - The Soroban contract (C...) address to probe.
   * @returns `true` if the contract's persistent instance entry exists;
   * `false` if the RPC reports "not found" (no contract at that address).
   *
   * @throws For any RPC failure other than "not found" (network/5xx after
   * the pool has exhausted all healthy endpoints). The error is logged
   * before being rethrown.
   *
   * @remarks Hits Soroban RPC (`getContractData`).
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
   * @param onError     - Called when the loop encounters an RPC error; the
   * loop stops after the first reported error
   * @returns           - Unsubscribe function; call it to stop the loop
   *
   * @remarks Hits Soroban RPC (`getEvents`) once per second via
   * {@link fetchContractEvents}. Returns synchronously — the polling loop
   * runs in the background until unsubscribed or an error occurs.
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

  // ----------------------------------------------------------
  // TRANSACTION STATUS LOOKUP
  // ----------------------------------------------------------

  /**
   * Fetches the status and metadata of a submitted Stellar transaction
   * directly from the Soroban RPC.
   *
   * Possible status values returned by the RPC:
   *  - SUCCESS    — transaction was included in a ledger and succeeded
   *  - FAILED     — transaction was included but its operation(s) failed
   *  - NOT_FOUND  — hash is unknown; may still be in the mempool (PENDING) or invalid
   *
   * The caller maps NOT_FOUND to a PENDING/NOT_FOUND distinction.
   * This method never throws for known statuses — it always returns a typed object.
   *
   * @param txHash  64-character hex transaction hash
   * @returns A typed status object with `hash`, `status`, `ledger`,
   * `createdAt`, `feeCharged`, `resultCode`, `envelopeXdr`, `resultXdr` and
   * decoded `events` (events are only populated for `SUCCESS` transactions
   * of the configured contract; decoding failures degrade to `[]`).
   *
   * @throws If the Soroban RPC call itself fails (network/5xx after the
   * pool has exhausted all healthy endpoints). The error is logged before
   * being rethrown.
   *
   * @remarks Hits Soroban RPC (`getTransaction`, and `getTransaction` again
   * via {@link getTransactionEvents} for `SUCCESS` transactions).
   */
  async getTransaction(txHash: string): Promise<{
    hash: string;
    status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'NOT_FOUND';
    ledger: number | null;
    createdAt: string | null;
    feeCharged: string | null;
    resultCode: string | null;
    envelopeXdr: string | null;
    resultXdr: string | null;
    events: any[];
  }> {
    return withSpan(
      'stellar.getTransaction',
      async (span) => {
        span.setAttribute('stellar.tx_hash', txHash);

        try {
          const tx = await this.rpcClient.getTransaction(txHash);
          span.setAttribute('stellar.tx_status', tx.status);

          if (tx.status === 'NOT_FOUND') {
            return {
              hash: txHash,
              status: 'NOT_FOUND' as const,
              ledger: null,
              createdAt: null,
              feeCharged: null,
              resultCode: null,
              envelopeXdr: null,
              resultXdr: null,
              events: [],
            };
          }

          // Extract result code from resultXdr when available
          let resultCode: string | null = null;
          if (tx.resultXdr) {
            try {
              const result = (tx.resultXdr as any).result?.();
              resultCode = result?.switch?.().name ?? null;
            } catch {
              // resultXdr may not be a parsed XDR object in all SDK versions
              resultCode = null;
            }
          }

          // Extract fee from envelopeXdr when available
          let feeCharged: string | null = null;
          if (tx.envelopeXdr) {
            try {
              const fee = (tx.envelopeXdr as any).tx?.().fee?.();
              feeCharged = fee != null ? String(fee) : null;
            } catch {
              feeCharged = null;
            }
          }

          // Decode createdAt from ledger close time when available
          const createdAt: string | null =
            (tx as any).createdAt
              ? new Date((tx as any).createdAt * 1000).toISOString()
              : null;

          // Decode contract events on success
          let events: any[] = [];
          if (tx.status === 'SUCCESS') {
            try {
              events = await this.getTransactionEvents(txHash);
            } catch {
              // Non-fatal — event decoding failure should not block the status response
              events = [];
            }
          }

          return {
            hash: txHash,
            status: tx.status as 'SUCCESS' | 'FAILED',
            ledger: tx.ledger ?? null,
            createdAt,
            feeCharged,
            resultCode,
            envelopeXdr: tx.envelopeXdr ? String(tx.envelopeXdr) : null,
            resultXdr: tx.resultXdr ? String(tx.resultXdr) : null,
            events,
          };
        } catch (error) {
          this.logger.error(`getTransaction(${txHash}) failed: ${error.message}`);
          throw error;
        }
      },
      { 'stellar.rpc_url': this.rpcPool.activeUrl },
      SpanKind.CLIENT,
    );
  }

  /**
   * Fetches the transaction's result meta from Soroban RPC and decodes
   * any events emitted by our contract.
   *
   * @param txHash - 64-character hex transaction hash.
   * @returns Array of decoded contract events belonging to the configured
   * contract, each shaped as
   * `{ id, contractId, type, topic, value, ledger, txHash }`.
   * Returns an empty array if the transaction is not `SUCCESS` or has no
   * result meta / no matching contract events.
   *
   * @throws `NotFoundException` if the transaction is not found by the RPC.
   * @throws For any other RPC or XDR-decoding failure; the error is logged
   * before being rethrown.
   *
   * @remarks Hits Soroban RPC (`getTransaction`) and decodes the returned
   * `resultMetaXdr` locally (no extra network calls).
   */
  async getTransactionEvents(txHash: string): Promise<any[]> {
    return withSpan(
      'stellar.getTransactionEvents',
      async (span) => {
        span.setAttribute('stellar.tx_hash', txHash);
        try {
          const tx = await this.rpcClient.getTransaction(txHash);
          if (tx.status === 'NOT_FOUND') {
            throw new NotFoundException(`Transaction ${txHash} not found`);
          }
          if (tx.status !== 'SUCCESS') {
            return [];
          }
          if (!tx.resultMetaXdr) {
            return [];
          }

          const meta = tx.resultMetaXdr as any;
          
          let sorobanMeta: any;
          if (meta.switch && meta.switch() === 3) {
            sorobanMeta = meta.v3().sorobanMeta();
          } else {
            try {
              sorobanMeta = meta.sorobanMeta();
            } catch {}
          }

          if (!sorobanMeta) {
            return [];
          }

          const events = sorobanMeta.events() ?? [];
          const decodedEvents = [];

          for (const e of events) {
            const contractIdBuf = e.contractId();
            if (!contractIdBuf) continue;

            const contractAddress = StrKey.encodeContract(contractIdBuf);
            if (contractAddress !== this.contractId) continue;

            if (e.type().name !== 'contract' && e.type().value !== 0) continue;

            const topics = e.body().v0().topics().map((t: any) => scValToNative(t));
            const value = scValToNative(e.body().v0().data());

            decodedEvents.push({
              id: `${txHash}-${decodedEvents.length}`,
              contractId: contractAddress,
              type: 'contract',
              topic: topics,
              value: value,
              ledger: tx.ledger,
              txHash: txHash,
            });
          }

          return decodedEvents;
        } catch (error) {
          if (error instanceof NotFoundException) {
            throw error;
          }
          this.logger.error(`getTransactionEvents(${txHash}) failed: ${error.message}`);
          throw error;
        }
      },
      { 'stellar.rpc_url': this.rpcPool.activeUrl },
      SpanKind.CLIENT,
    );
  }
}
