# Internationalization (i18n)

ChainSettle localizes API error messages and notification-email copy via
`src/i18n`. Locale is resolved from the `Accept-Language` request header
(with English as the fallback).

## Supported locales

| Code | Language |
|------|----------|
| `en` | English (default) |
| `es` | Spanish |

## How locale resolution works

1. `LocaleMiddleware` reads `Accept-Language` on every request.
2. The first supported primary language tag wins (e.g. `es-MX` → `es`).
3. Missing or unsupported values fall back to `en`.

Example:

```http
GET /api/v1/shipments/missing-id
Accept-Language: es
```

returns a Spanish `message` when that string is mapped in `errors.*`.

## Adding a new locale

1. Create `src/i18n/locales/<code>/common.json` by copying the `en` file.
2. Translate every string under `errors` and `email`.
3. Add `<code>` to `SUPPORTED_LOCALES` in `src/i18n/i18n.service.ts`.
4. Ensure `nest-cli.json` still copies JSON assets (already configured for `i18n/locales/**/*.json`).
5. Verify with:

```bash
curl -H "Accept-Language: <code>" http://localhost:3000/api/v1/...
```

## Error message keys

Services may throw either:

- Plain English strings that already exist as `errors.*` English values
  (the filter reverse-matches and translates), or
- Structured payloads: `throw new NotFoundException({ i18nKey: 'errors.SHIPMENT_NOT_FOUND', args: { id } })`

Prefer structured keys for new code so interpolation stays unambiguous.

## Email templates

Handlebars templates under `src/modules/notifications/templates/` can use
`I18nService.getEmailCopy(type, locale)` for localized subject/body strings.
Until callers pass a locale, English copy is used.
