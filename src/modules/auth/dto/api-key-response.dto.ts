import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Shape returned by list / create API-key endpoints.
 * The `key` field is present only on the create response (plaintext, shown once).
 */
export class ApiKeyResponseDto {
  @ApiProperty({ example: '3f2a1c9d-...', description: 'UUID of the API key record' })
  id: string;

  @ApiProperty({ example: 'CI Pipeline', description: 'Human-readable label' })
  name: string;

  @ApiProperty({
    example: ['read'],
    description:
      'Scopes granted to this key. "read" allows GET/HEAD; "write" also allows POST/PUT/PATCH/DELETE.',
    type: [String],
    enum: ['read', 'write'],
  })
  scopes: string[];

  @ApiPropertyOptional({
    example: '2027-09-25T00:00:00.000Z',
    description: 'ISO 8601 expiry timestamp, or null if the key never expires.',
    nullable: true,
  })
  expiresAt: Date | null;

  @ApiPropertyOptional({
    example: '2026-09-25T12:00:00.000Z',
    description: 'Timestamp of the most recent successful request using this key.',
    nullable: true,
  })
  lastUsedAt: Date | null;

  @ApiProperty({ example: '2026-09-25T09:00:00.000Z' })
  createdAt: Date;

  /**
   * Only present in the POST (create) response — the raw key is returned
   * exactly once and never stored. Consumers must save it immediately.
   */
  @ApiPropertyOptional({
    example: 'a1b2c3d4e5f6...',
    description:
      'Plaintext API key — present only on creation. Store it securely; it cannot be retrieved again.',
  })
  key?: string;
}
