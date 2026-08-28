# Multi-token support and onboarding a new payment token

This project supports multiple payment tokens through the token registry, but the registry is only usable when the token is configured correctly and the token entry matches the on-chain decimals used by the asset.

## 1. Register the token through the admin API

Use the admin route to register a supported token before it is available for new shipments:

```bash
curl -X POST "$API_BASE/admin/tokens" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "symbol": "USDC",
    "displayName": "USD Coin",
    "decimals": 7
  }'
```

The route verifies that the contract exists on-chain, then stores the token in the in-memory registry used by shipment creation.

## 2. Decimal precision gotcha

This is the most common onboarding mistake: decimals must match the token's real contract precision.

On Stellar, many Soroban tokens use 7 decimal places even when the UI or a human expects a simpler value. If a token is registered with the wrong decimals, the backend will store the wrong raw amount and any downstream value calculations (USD conversion, milestone amounts, and settlement math) will be wrong.

The safe rule is:

- verify the token's native contract decimals on-chain
- register that exact value in the registry
- never change decimals after the token has already been used by a shipment

If a token is registered incorrectly, use the administrative update route to correct the entry before any shipments reference it.

## 3. Contract-side allowlisting / deployment requirements

Before the backend can use a token for shipment creation, the token must be properly deployed and recognized by the chain settlement contract. In practice that means:

- the token contract must exist at the contract address being registered
- the token must be one the settlement contract accepts for escrow flow
- any allowlist or vendor configuration in the chain contract must include the token as a supported payment asset

If this is being done in the companion `chainsetttle-contract` repo, make sure the contract configuration and metadata are updated there as part of the same rollout.

## 4. Use the token in shipment creation

Once the token is registered and enabled, a shipment can be created with it through the normal shipment request flow. The backend reads the token metadata from the registry, stores the token decimals and symbol on the shipment, and uses those values for all amount conversions and milestone calculations.

A token that has been disabled via the admin patch endpoint will be rejected for new shipment creation, but historical shipments already using it remain unaffected.

## 5. Admin maintenance

If a token needs to be corrected or disabled, use the admin update route:

```bash
curl -X PATCH "$API_BASE/admin/tokens/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": false,
    "displayName": "USD Coin"
  }'
```

The update endpoint accepts partial updates, but it rejects decimal changes once shipments already reference that token.

## Result

Following this sequence end-to-end ensures the new payment token is valid, correctly configured, and usable for shipment creation without corrupting historical amount calculations.
