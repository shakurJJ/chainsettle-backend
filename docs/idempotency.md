# Idempotency

The ChainSettle API supports idempotency for safe retries of network requests. If a network connection drops before you receive a response, you can safely retry the identical request without worrying about creating duplicate records.

## How it works

Clients opt-in to idempotency by sending an `Idempotency-Key` header with their request. The server caches the response of the first successful request against this key. If the server sees a subsequent request with the same key, it will simply return the cached response rather than executing the operation again.

### Recommended Key Format
We strongly recommend using **UUID v4** strings for your idempotency keys (e.g., `Idempotency-Key: 7b233fb1-7893-4a11-b4d4-53a5cce3eb1a`). The keys are scoped strictly to the authenticated user, meaning a key collision with another user will not expose their data.

### TTL (Time to Live)
Idempotency keys are cached for exactly **24 hours**. Any request sent with a key older than 24 hours will be treated as a brand new request and executed normally.

## Supported Endpoints

Currently, idempotency is strictly opt-in and is supported on the following endpoint:

- `POST /shipments` (Register a new shipment)

## Expected Behavior

Understanding how the API responds in edge cases is important for robust client implementations:

- **First Request:** The API executes the request normally. Upon success, the HTTP response status code and JSON body are cached in Redis under your key for 24 hours.
- **Retry with the Same Body:** The API detects the key in the cache and immediately returns the cached HTTP response and status code. The database is not modified.
- **Reuse with a Different Body (Conflict):** The API currently **does not** hash or compare the request bodies. If you reuse a key with a different payload, the API will ignore the new payload and simply return the original cached response. *Always generate a new idempotency key if the payload changes!*
- **Concurrent In-Flight Requests:** The current implementation uses a naive read-then-write caching strategy without distributed locking. If two identical requests arrive at the exact same millisecond before the first one finishes executing and caches its response, both may bypass the cache check and execute in parallel (potentially resulting in duplicate database records).

## Client-side Retry Example

Below is an example using `fetch` to safely retry a `POST /shipments` creation if the network drops:

```javascript
async function createShipmentWithRetry(payload, maxRetries = 3) {
  // 1. Generate a single key for this operation
  const idempotencyKey = crypto.randomUUID(); 
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.chainsettle.io/v1/shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer YOUR_JWT',
          'Idempotency-Key': idempotencyKey, // 2. Send the key
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();

    } catch (error) {
      console.warn(`Attempt ${attempt} failed. Retrying...`, error);
      if (attempt === maxRetries) {
        throw new Error('Max retries reached. Shipment creation failed.');
      }
      
      // Wait before retrying (exponential backoff recommended in production)
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}
```
