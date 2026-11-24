import {
  BadRequestException,
  BadGatewayException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  FeeBumpTransaction,
  Keypair,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { StellarService } from '../../common/stellar/stellar.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';

const MAX_SEND_RETRIES = 3;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Relays client-signed transactions to Stellar RPC, retrying transient
 * TRY_AGAIN_LATER responses and pushing the final status over WebSocket.
 */
@Injectable()
export class TransactionRelayService {
  private readonly logger = new Logger(TransactionRelayService.name);

  constructor(
    private readonly stellar: StellarService,
    private readonly gateway: NotificationsGateway,
  ) {}

  async submit(signedXdr: string, caller: { id: string; stellarAddress: string }) {
    const tx = this.decode(signedXdr);
    const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;

    if (inner.source !== caller.stellarAddress) {
      throw new ForbiddenException('Transaction source account must be the caller');
    }
    // The tx hash commits to the network passphrase, so a valid caller signature
    // proves the envelope was signed for this network.
    if (!this.hasValidSignature(inner, caller.stellarAddress)) {
      throw new BadRequestException(
        'Transaction is not signed by the caller for this network (network passphrase mismatch?)',
      );
    }

    const sent = await this.sendWithRetry(tx);
    if (sent.status === 'ERROR') {
      this.pushStatus(caller.id, sent.hash, 'FAILED', sent.errorResult?.toXDR('base64'));
      return { hash: sent.hash, status: 'FAILED' };
    }

    void this.trackFinalStatus(sent.hash, caller.id);
    return { hash: sent.hash, status: sent.status };
  }

  private decode(signedXdr: string): Transaction | FeeBumpTransaction {
    try {
      return TransactionBuilder.fromXDR(signedXdr, this.stellar.getNetworkPassphrase());
    } catch {
      throw new BadRequestException('signedXdr is not a valid transaction envelope');
    }
  }

  private hasValidSignature(tx: Transaction, address: string): boolean {
    const keypair = Keypair.fromPublicKey(address);
    const hash = tx.hash();
    return tx.signatures.some((sig) => {
      try {
        return keypair.verify(hash, sig.signature());
      } catch {
        return false;
      }
    });
  }

  private async sendWithRetry(tx: Transaction | FeeBumpTransaction) {
    const rpc = this.stellar.getClient();
    for (let attempt = 0; ; attempt++) {
      let res: SorobanRpc.Api.SendTransactionResponse;
      try {
        res = await rpc.sendTransaction(tx);
      } catch (err: any) {
        if (attempt >= MAX_SEND_RETRIES) throw new BadGatewayException(`RPC submit failed: ${err.message}`);
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.status !== 'TRY_AGAIN_LATER' || attempt >= MAX_SEND_RETRIES) return res;
      this.logger.debug(`TRY_AGAIN_LATER for ${res.hash}, retry ${attempt + 1}`);
      await sleep(500 * 2 ** attempt);
    }
  }

  private async trackFinalStatus(hash: string, userId: string) {
    const rpc = this.stellar.getClient();
    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const res = await rpc.getTransaction(hash);
        if (res.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          return this.pushStatus(userId, hash, 'SUCCESS', undefined, res.ledger);
        }
        if (res.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
          return this.pushStatus(userId, hash, 'FAILED', res.resultXdr?.toXDR('base64'), res.ledger);
        }
      } catch (err: any) {
        this.logger.warn(`Polling ${hash} failed: ${err.message}`);
      }
    }
    this.pushStatus(userId, hash, 'TIMEOUT');
  }

  private pushStatus(userId: string, hash: string, status: string, resultXdr?: string, ledger?: number) {
    this.gateway.pushEvent(userId, 'chain:tx', { hash, status, resultXdr, ledger });
  }
}
