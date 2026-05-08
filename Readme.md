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
LLC "Status Goroda" (6417001343)
Context : 225f56fa-da88-49d2-a5ef-afg2e3060168
Period : 2026-01-01

Receipts loaded (70) : 28.72 s

Saving : 1.41 s
Created : 0
Updated : 0
Errors : 0
Unchanged : 70

PDF receipts : 2.36 s
Unchanged : 70
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

The base class also calls:

```js
setCondoSettings({ settings, recipients })
```

Use it to apply per-context settings and recipient overrides.

## Minimal receipt shape

A receipt must contain:
- `accountNumber: string | number`
- `address: string`
- `tin: string | number`
- `bankAccount: string | number`
- `routingNumber: string | number`
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

## Refactoring and test roadmap

### Phase 1. Baseline tests

1. Keep all tests on native Node tools only.
2. Cover retry, timeout and abort scenarios in `fetchWithRetry`.
3. Add redirect + Basic auth regression tests.

### Phase 2. Sync decomposition

1. Split `Sync` into focused parts:
   - argument parser
   - sync orchestrator
   - report builder/notifier
2. Inject dependencies for testability (CONDO client, notifier, clock).
3. Add unit tests for period fallback and error handling.

### Phase 3. Mapping and validation

1. Extract receipt mapping from `CondoBilling` into a dedicated mapper.
2. Add receipt validation (required fields and types).
3. Add tests for money conversion and mapping edge cases.

### Phase 4. Integration helpers

1. Analyze multiple real integrations and extract shared helpers.
2. Start with reusable helpers for:
   - pagination
   - Basic/Bearer auth clients
   - period filtering
   - receipt shaping utilities
3. Add helper-level tests and contract tests.

## License

MIT
