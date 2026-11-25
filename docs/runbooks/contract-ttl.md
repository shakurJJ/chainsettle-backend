# Runbook: Soroban contract storage TTL

Soroban archives ledger entries whose TTL expires. An archived contract instance or
shipment entry breaks every call touching it, so the API monitors TTLs.

## Monitoring

`ContractTtlMonitorService` (`src/modules/chain/contract-ttl-monitor.service.ts`) runs every
`CONTRACT_TTL_CHECK_INTERVAL_MS` (default 1 h) and reads the live-until ledger of:

- the contract instance (`entry="instance"`)
- each ACTIVE shipment's persistent entry (`entry="shipment:<id>"`)

It exports `chainsettle_contract_ttl_ledgers_remaining{entry}` and, when an entry drops below
`CONTRACT_TTL_ALERT_THRESHOLD_LEDGERS` (default 120 960 ≈ 7 days at 5 s/ledger), logs an error
and sends a `SYSTEM_ALERT` notification to every admin (once per entry until it recovers).

Suggested Prometheus alert:

```yaml
- alert: ChainSettleContractTtlLow
  expr: min(chainsettle_contract_ttl_ledgers_remaining) < 120960
  for: 10m
```

## Extending the TTL

Using the Stellar CLI with a funded source account:

```bash
# Contract instance (and its code)
stellar contract extend --id $CHAINSETTTLE_CONTRACT_ID --durability persistent \
  --ledgers-to-extend 535679 --source admin --network $STELLAR_NETWORK

# A specific persistent entry, e.g. a shipment
stellar contract extend --id $CHAINSETTTLE_CONTRACT_ID --durability persistent \
  --key-xdr <base64 ScVal key> --ledgers-to-extend 535679 --source admin --network $STELLAR_NETWORK
```

If an entry is already archived, restore it first with `stellar contract restore` using the same
key, then extend it. Confirm the gauge rises on the next check.
