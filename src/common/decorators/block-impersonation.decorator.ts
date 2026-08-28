import { SetMetadata } from '@nestjs/common';

export const BLOCK_IMPERSONATION_KEY = 'blockImpersonation';

/**
 * Marks sensitive routes that must not be callable with an impersonation token
 * (e.g. changing email, deleting the account).
 */
export const BlockImpersonation = () => SetMetadata(BLOCK_IMPERSONATION_KEY, true);
