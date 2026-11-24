import { IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SnoozeNotificationDto {
  /**
   * ISO 8601 timestamp until which the notification should be hidden.
   * Must be a future date. The notification reappears as unread once this
   * time passes; its read/unread state is never changed by snoozing.
   *
   * @example "2026-10-01T09:00:00.000Z"
   */
  @ApiProperty({
    description:
      'ISO 8601 UTC timestamp until which the notification is hidden from the list. ' +
      'Must be in the future. The notification reappears automatically once this time ' +
      'passes without changing its read/unread state.',
    example: '2026-10-01T09:00:00.000Z',
  })
  @IsDateString()
  until: string;
}
