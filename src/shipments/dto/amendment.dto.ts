import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export enum ShipmentAmendmentStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
}

export class ProposeAmendmentDto {
  @IsObject()
  @IsNotEmpty()
  changes: Record<string, unknown>;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class AmendmentDecisionDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class ShipmentAmendmentResponseDto {
  id: string;
  shipmentId: string;
  proposedBy: string;
  changes: Record<string, unknown>;
  status: ShipmentAmendmentStatus;
  reason?: string;
  decidedBy?: string;
  decidedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
