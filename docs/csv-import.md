# CSV Bulk Import

The `POST /shipments/import` endpoint allows users to upload a CSV file to bulk-create multiple **draft** shipments at once. 

## What is a Draft Shipment?
Draft shipments (`isDraft = true`) are staging records in the database. They do not have an on-chain smart contract equivalent yet (i.e. no `txHash`, no `createdLedger`). They are purely off-chain templates that you can review, update, or cancel. You must explicitly launch them on-chain via the frontend or a separate API call before they become active live shipments.

## File Format & Limits
- **File Type:** `.csv`
- **Max Rows:** 100 rows per import (excluding the header row).
- **Encoding:** UTF-8 (BOM is automatically stripped).

## Columns Specification

Your CSV must include a header row. Column names are **case-insensitive** and empty lines are skipped automatically.

| Column Name | Required | Type | Example | Description |
|---|---|---|---|---|
| `supplierAddress` | **Yes** | String (Stellar Public Key) | `GDQ2...` | The Stellar address of the supplier. |
| `logisticsAddress` | **Yes** | String (Stellar Public Key) | `GDQ3...` | The Stellar address of the logistics provider. |
| `arbiterAddress` | **Yes** | String (Stellar Public Key) | `GDQ4...` | The Stellar address of the arbiter. |
| `tokenAddress` | **Yes** | String (Stellar Contract ID) | `CBIELT...` | The Stellar contract address of the payment token (e.g., USDC or EURC). Must be a registered token. |
| `totalAmount` | **Yes** | String (Positive Integer) | `10000000` | The total value of the shipment in the token's **smallest unit** (e.g., stroops). Must be > 0. |
| `description` | No | String | `"Batch 1"` | A human-readable description of the shipment. Max 1000 characters. |
| `referenceNumber` | No | String | `"PO-1001"` | Your internal PO or reference number. Must be **unique** across the entire system. |
| `milestones` | No | Delimited String | `"Deposit:30\|Delivery:70"` | The payment milestones for the shipment. Formatted as `Name:Percentage`. Multiple milestones are separated by a pipe (`\|`). |

## Milestone Encoding (`milestones` column)

To automatically generate milestones for your draft shipments, use the `milestones` column. 
- The format for a single milestone is `Name:Percentage` (e.g., `Deposit:30`).
- If you have multiple milestones, separate them with a pipe (`|`). 
- **Validation:** The sum of all percentages in the row must equal exactly **100**. The percentages must be positive integers. 
- **Example:** `"Deposit:30|Quality Check:20|Final Delivery:50"`

## Error Response & Validation

The CSV parser processes each row **independently**. If one row contains an error, the parser will still attempt to create draft shipments for the remaining valid rows. 

The API returns a JSON response outlining the result of every row processed:

```json
{
  "results": [
    {
      "row": 2,
      "status": "created",
      "shipmentId": "uuid-1234-..."
    },
    {
      "row": 3,
      "status": "error",
      "error": "totalAmount must be a positive integer (got \"-500\")"
    },
    {
      "row": 4,
      "status": "error",
      "error": "Milestone percentages must sum to 100. Got 90."
    }
  ]
}
```
*Note: The `row` index in the response is 1-based and accounts for the header row (i.e. the first data row is `row: 2`).*

## Sample CSV

A downloadable sample CSV is available here:  
[`docs/examples/shipments-import.csv`](./examples/shipments-import.csv)
