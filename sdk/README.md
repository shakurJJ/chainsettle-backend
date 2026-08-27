# @chainsettle/sdk

Auto-generated TypeScript client for the ChainSettle REST API.

## Regenerate

From the backend repo root:

```bash
npm run generate:sdk
```

This refreshes `openapi.json` from the NestJS Swagger document and regenerates `schema.ts`.

## Usage

```ts
import { createClient } from '@chainsettle/sdk';

const client = createClient({
  baseUrl: 'http://localhost:3000',
  accessToken: process.env.TOKEN,
});

const shipments = await client.v1.getShipments({ page: 1 });
const detail = await client.v1.getShipment('SHIP-001');
```

## CI drift check

`npm run check:sdk` regenerates the SDK and fails if `sdk/` differs from git.
