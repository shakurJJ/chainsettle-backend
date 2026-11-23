import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class ImportContactsDto {
  @ApiProperty({
    description:
      'Raw CSV content with header row. Supported columns: name, stellarAddress, email, notes. Max 1,000 data rows.',
    example:
      'name,stellarAddress,email,notes\nAlice,GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H,alice@example.com,partner',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1_000_000)
  csv: string;
}
