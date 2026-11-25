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

## Microsoft Teams webhook

Set `teamsWebhookUrl` through `PATCH /api/v1/notifications/preferences` to
configure a Microsoft Teams Incoming Webhook. To remove it, pass `null` or an
empty string. Teams delivery is enabled per notification type with the `teams`
channel flag; it is disabled by default.

```json
{
  "teamsWebhookUrl": "https://<tenant>.webhook.office.com/webhookb2/...",
  "preferences": {
    "PROOF_SUBMITTED": {
      "inApp": true,
      "email": true,
      "teams": true
    }
  }
}
```

Call `POST /api/v1/notifications/teams/test` to send a test Adaptive Card to the
configured webhook. Teams webhook delivery retries once when rate limited.
Delivery failures are logged and do not interrupt other notification channels.
