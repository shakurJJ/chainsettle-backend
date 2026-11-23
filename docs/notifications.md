# Notifications

The backend sends notification events through per-user channels. The Telegram bot
is optional and disabled unless `TELEGRAM_ENABLED=true` and a valid
`TELEGRAM_BOT_TOKEN` from BotFather is configured. On startup, the backend calls
Telegram's `getMe`; an invalid token or unavailable Telegram API prevents the
enabled channel from starting.

When enabled, Telegram uses long polling for `/start` account-link messages. A
Redis distributed lock and shared update offset ensure only one application
replica polls a bot at a time.

## Link or unlink Telegram

1. Authenticate and call `POST /api/v1/notifications/telegram/link`.
2. Open the returned `link` in Telegram within 10 minutes and press **Start**.
3. The bot confirms when the chat is linked. `GET /api/v1/notifications/preferences`
   returns `telegramLinked: true`.
4. Call `DELETE /api/v1/notifications/telegram/link` to unlink the chat. A new
   link code invalidates any earlier unused code.

The bot only accepts account-link commands in a private chat. Link codes are
random, expire after 10 minutes, are stored as SHA-256 hashes, and can be used
once.

## Telegram event preferences

Telegram delivery defaults on for `DISPUTE_RAISED`, `DISPUTE_RESOLVED`,
`PAYMENT_RELEASED`, `MILESTONE_OVERDUE`, and `SYSTEM_ALERT`; it defaults off for
other event types. Users can change these per-type flags using
`PATCH /api/v1/notifications/preferences`, for example:

```json
{
  "preferences": {
    "PROOF_SUBMITTED": {
      "inApp": true,
      "email": true,
      "telegram": true
    }
  }
}
```

Telegram messages respect quiet hours. Set `TELEGRAM_ENABLED=false` to disable
the bot integration, and do not expose the bot token to clients.
