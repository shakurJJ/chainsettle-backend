import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BASE_FEE,
  Contract,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { MilestoneStatus, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from './stellar.service';

export interface PreparedTransaction {
  xdr: string;
  networkPassphrase: string;
  simulatedFee: string;
  expiresAtLedger: number;
}

/** Transaction validity window; ~5s per ledger. */
const TX_TIMEOUT_SECONDS = 300;
const LEDGER_SECONDS = 5;

/**
 * Builds and simulates Soroban contract invocations server-side and returns
 * unsigned, resource-assembled XDR for the caller's wallet (Freighter) to sign.
 * Role/state checks mirror the corresponding submit endpoints.
 */
@Injectable()
export class TransactionBuilderService {
  constructor(
    private readonly stellar: StellarService,
    private readonly prisma: PrismaService,
  ) {}

  async prepareConfirmMilestone(shipmentId: string, index: number, caller: string) {
    const shipment = await this.loadActiveShipment(shipmentId);
    if (shipment.buyerAddress !== caller) {
      throw new ForbiddenException('Only the shipment buyer may confirm milestones');
    }
    const milestone = await this.loadMilestone(shipmentId, index);
    if (milestone.status !== MilestoneStatus.PROOF_SUBMITTED) {
      throw new ConflictException(`Milestone ${index} is not in PROOF_SUBMITTED status`);
    }
    return this.build(caller, 'confirm_milestone', [
      this.address(caller),
      nativeToScVal(shipmentId, { type: 'string' }),
      nativeToScVal(index, { type: 'u32' }),
    ]);
  }

  async prepareRaiseDispute(shipmentId: string, index: number, caller: string, reason = '') {
    const shipment = await this.loadActiveShipment(shipmentId);
    if (shipment.buyerAddress !== caller && shipment.supplierAddress !== caller) {
      throw new ForbiddenException('Only the buyer or supplier may raise a dispute');
    }
    const milestone = await this.loadMilestone(shipmentId, index);
    if (
      milestone.status !== MilestoneStatus.PENDING &&
      milestone.status !== MilestoneStatus.PROOF_SUBMITTED
    ) {
      throw new ConflictException(`Cannot dispute milestone ${index} in ${milestone.status} status`);
    }
    return this.build(caller, 'raise_dispute', [
      this.address(caller),
      nativeToScVal(shipmentId, { type: 'string' }),
      nativeToScVal(index, { type: 'u32' }),
      nativeToScVal(reason, { type: 'string' }),
    ]);
  }

  async prepareCancelShipment(shipmentId: string, caller: string) {
    const shipment = await this.loadActiveShipment(shipmentId);
    if (shipment.buyerAddress !== caller) {
      throw new ForbiddenException('Only the shipment buyer can cancel it');
    }
    return this.build(caller, 'cancel_shipment', [
      this.address(caller),
      nativeToScVal(shipmentId, { type: 'string' }),
    ]);
  }

  private address(addr: string): xdr.ScVal {
    return nativeToScVal(addr, { type: 'address' });
  }

  private async loadActiveShipment(id: string) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id } });
    if (!shipment) throw new NotFoundException(`Shipment ${id} not found`);
    if (shipment.status !== ShipmentStatus.ACTIVE) {
      throw new ConflictException(`Shipment is not ACTIVE (current status: ${shipment.status})`);
    }
    return shipment;
  }

  private async loadMilestone(shipmentId: string, milestoneIndex: number) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
    });
    if (!milestone) throw new NotFoundException(`Milestone ${milestoneIndex} not found`);
    return milestone;
  }

  private async build(source: string, method: string, args: xdr.ScVal[]): Promise<PreparedTransaction> {
    const rpc = this.stellar.getClient();
    const networkPassphrase = this.stellar.getNetworkPassphrase();

    const account = await rpc.getAccount(source).catch(() => {
      throw new UnprocessableEntityException(`Source account ${source} not found on-chain`);
    });

    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
      .addOperation(new Contract(this.stellar.getContractId()).call(method, ...args))
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();

    const [sim, latest] = await Promise.all([rpc.simulateTransaction(tx), rpc.getLatestLedger()]);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new UnprocessableEntityException({
        message: `Simulation of ${method} failed`,
        error: sim.error,
        events: (sim.events ?? []).map((e) => e.toXDR('base64')),
      });
    }

    const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
    return {
      xdr: prepared.toXDR(),
      networkPassphrase,
      simulatedFee: sim.minResourceFee,
      expiresAtLedger: latest.sequence + Math.ceil(TX_TIMEOUT_SECONDS / LEDGER_SECONDS),
    };
  }
}
