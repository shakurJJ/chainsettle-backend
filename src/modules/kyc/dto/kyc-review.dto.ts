import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { KycStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class KycQueueQueryDto {
  @ApiPropertyOptional({ enum: KycStatus, default: KycStatus.PENDING })
  @IsOptional()
  @IsEnum(KycStatus)
  status?: KycStatus = KycStatus.PENDING;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class KycApproveDto {
  @ApiPropertyOptional({
    description: 'Optional reviewer note recorded in the audit log',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class KycRejectDto {
  @ApiProperty({
    description: 'Why the case was rejected — shown to the user and audited',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
