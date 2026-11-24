import { SetMetadata } from '@nestjs/common';

export const TIMEOUT_KEY = 'timeout';

/**
 * Decorator to override the default request timeout for a specific route.
 * Use this for long-running operations like exports and imports.
 * 
 * @param ms - Timeout in milliseconds (default: 30000ms = 30 seconds)
 * 
 * @example
 * // Set 5 minute timeout for export endpoint
 * @Timeout(300000)
 * @Get('export/users')
 * async exportUsers() { ... }
 */
export const Timeout = (ms: number) => SetMetadata(TIMEOUT_KEY, ms);