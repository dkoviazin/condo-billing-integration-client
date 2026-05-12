# condo-billing-integration-client

A Node.js client for building billing integrations with CONDO.

It provides a reusable sync runtime:
- loads receipts from an external system
- saves them to CONDO
- uploads receipt PDFs (if available)
- sends a sync report to Telegram (optional)

## Runtime flow

1. Authenticate in CONDO.
2. Load billing context and integration settings.
3. Call your integration (`getAllReceipts`).
4. Save receipts to CONDO in chunks.
5. Upload PDF files for receipts that have them.
6. Send a report (Telegram webhook or stdout fallback).
7. If no receipts were found for the target period, optionally try previous months.

## Requirements

- Node.js `v22.17.0`

## Installation

```bash
yarn install
```

## Environment variables

### Required

```env
CONDO_INTEGRATION='{"endpoint":"https://<condo>/admin/api","authRequisites":{"identity":"<email>","password":"<password>"}}'
```

`authRequisites` supports:
- `identity/password`
- `phone/password`
- `token`

### Optional (Telegram notifications)

```env
NOTIFY_TELEGRAM='{"url":"https://<bot-webhook>","chatId":"-100..."}'
```

### Optional (report language)

```env
REPORT_LANG='en'
```

Supported values:
- `ru` (default)
- `en`

## Running an integration

Typical command:

```bash
node index.js -c <BILLING_CONTEXT_ID> -p 2026-04-01
```

Arguments:
- `-c`, `--context` (required): billing context id
- `-p`, `--period` (optional): period in `YYYY-MM-01` format

If `-p` is omitted, current month start is used.

## Report example

```text
ООО "Название организации" (ИНН)
Контекст : ID-Контекста
Период : 2026-01-01

Загружено квитанций (70) : 28.72 s

Сохранение : 1.41 s
Новых : 0
Обновлено : 0
Ошибок : 0
Не изменилось : 70

PDF квитанции : 2.36 s
Не изменилось : 70
```

## Integration contract

Every integration must implement this interface:

```js
class Integration {
    async getAllReceipts ({ tin, period }) {
        throw new Error('Not implemented')
    }

    hasPDFFile (receipt) {
        throw new Error('Not implemented')
    }

    async getPDFBuffer (receipt) {
        throw new Error('Not implemented')
    }
}
```

## Minimal receipt shape

A receipt must contain:
- `accountNumber: string | number` // Л/С
- `address: string`                // Адрес вместе с помещением
- `tin: string | number`           // ИНН
- `bankAccount: string | number`   // Р/С
- `routingNumber: string | number` // БИК
- `year: number`
- `month: number`
- `toPay: number | string`

Recommended:
- `importId` for idempotency
- `services[]` for itemized lines
- `toPayDetails` for detailed totals

## Testing

This project uses native Node testing stack:
- `node:test`
- `node:assert/strict`

Run tests:

```bash
npm test
```

Watch mode:

```bash
npm run test:watch
```

## License

MIT
