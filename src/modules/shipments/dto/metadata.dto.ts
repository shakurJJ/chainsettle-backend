import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class ValidateMetadataDto {
  @ApiProperty({
    description: 'The JSON schema to validate against',
    enum: ['incoterms', 'customs'],
  })
  @IsNotEmpty()
  @IsString()
  @IsIn(['incoterms', 'customs'])
  schema: 'incoterms' | 'customs';
}
