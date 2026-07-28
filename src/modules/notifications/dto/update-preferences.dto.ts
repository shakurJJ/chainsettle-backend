import { IsIn, IsObject, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { DigestFrequency } from '../notifications.service';

const DIGEST_FREQUENCIES: DigestFrequency[] = ['instant', 'daily', 'weekly'];

export class UpdatePreferencesDto {
  @ApiProperty({
    description: 'Partial map of NotificationType to channel flags',
    example: { PROOF_SUBMITTED: { inApp: true, email: false } },
    required: false,
  })
  @IsOptional()
  @IsObject()
  preferences?: Partial<Record<NotificationType, { inApp: boolean; email: boolean }>>;

  @ApiProperty({
    description: 'How often to receive the notification digest email',
    enum: DIGEST_FREQUENCIES,
    required: false,
  })
  @IsOptional()
  @IsIn(DIGEST_FREQUENCIES)
  digestFrequency?: DigestFrequency;
}
