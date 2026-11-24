import { ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';

@ObjectType()
export class ProofSubmissionGql {
  @Field(() => ID)
  id: string;

  @Field()
  milestoneId: string;

  @Field()
  ipfsCid: string;

  @Field()
  submittedBy: string;

  @Field()
  createdAt: Date;
}

@ObjectType()
export class MilestoneGql {
  @Field(() => ID)
  id: string;

  @Field()
  shipmentId: string;

  @Field(() => Int)
  milestoneIndex: number;

  @Field()
  name: string;

  @Field(() => Int)
  paymentPercent: number;

  @Field()
  status: string;

  @Field({ nullable: true })
  proofHash?: string;

  @Field({ nullable: true })
  confirmedAt?: Date;

  @Field({ nullable: true })
  dueAt?: Date;

  @Field({ nullable: true, description: 'Exact amount released for this milestone, as a string (stroops)' })
  paymentReleased?: string;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field(() => [ProofSubmissionGql], { description: 'Proof upload history, oldest first' })
  proofSubmissions?: ProofSubmissionGql[];
}

@ObjectType()
export class ChainEventGql {
  @Field(() => ID)
  id: string;

  @Field()
  eventName: string;

  @Field(() => Int)
  ledger: number;

  @Field()
  txHash: string;

  @Field()
  createdAt: Date;
}

@ObjectType()
export class ShipmentGql {
  @Field(() => ID)
  id: string;

  @Field()
  buyerAddress: string;

  @Field()
  supplierAddress: string;

  @Field()
  logisticsAddress: string;

  @Field()
  arbiterAddress: string;

  @Field()
  status: string;

  @Field()
  totalAmount: string;

  @Field()
  releasedAmount: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  referenceNumber?: string;

  @Field({ nullable: true })
  expectedDeliveryAt?: Date;

  @Field()
  createdAt: Date;

  @Field(() => [MilestoneGql])
  milestones: MilestoneGql[];

  @Field(() => [ChainEventGql])
  recentEvents: ChainEventGql[];
}
