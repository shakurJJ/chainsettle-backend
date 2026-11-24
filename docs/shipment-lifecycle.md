# Shipment & Milestone Lifecycle

This document describes the state machines governing shipments and milestones in ChainSettle.

## Table of Contents

- [Shipment State Machine](#shipment-state-machine)
- [Milestone State Machine](#milestone-state-machine)
- [Arbiter State Machine](#arbiter-state-machine)
- [Related Concepts](#related-concepts)

---

## Shipment State Machine

A **Shipment** represents a transaction between a buyer and supplier, governed by the escrow smart contract on Stellar. Shipments progress through three primary states:

```
ACTIVE ──────> COMPLETED
   │
   └────────> CANCELLED
```

### States

| State       | Description                                                                                  |
|-------------|----------------------------------------------------------------------------------------------|
| `ACTIVE`    | Shipment is in progress. Milestones may be submitted, confirmed, or disputed.               |
| `COMPLETED` | All milestones have been confirmed; funds have been fully released. Shipment is now terminal.|
| `CANCELLED` | Shipment was cancelled on-chain. Remaining funds are refunded to the buyer. Terminal state.  |

### Transitions

#### ACTIVE → COMPLETED

**Trigger**: All milestones reach `CONFIRMED` or `RESOLVED` status, and the full `totalAmount` has been released.

**Side Effects**:
- `status` set to `COMPLETED`
- Participants notified via email/push
- Shipment becomes eligible for archival after retention period (90 days by default)

#### ACTIVE → CANCELLED

**Trigger**: Contract admin or authorized party invokes `cancel_shipment` on-chain. Alternatively, buyer may cancel before milestones are submitted.

**Side Effects**:
- `status` set to `CANCELLED`
- `cancelledAt` timestamp recorded
- `refundTxHash` captured (transaction hash of the cancellation/refund)
- Remaining escrowed funds returned to buyer
- No further milestone updates allowed
- Participants notified

**Notes**:
- Cancellation is irreversible
- Confirmed milestones are not reversed; only unreleased funds are refunded

---

## Milestone State Machine

Each shipment is divided into **Milestones**, representing incremental delivery checkpoints. Milestones transition through the following states:

```
PENDING ──────> PROOF_SUBMITTED ──────> CONFIRMED
                      │
                      └───────────────> DISPUTED ──────> RESOLVED
```

### States

| State             | Description                                                                                     |
|-------------------|-------------------------------------------------------------------------------------------------|
| `PENDING`         | Initial state. Awaiting proof submission from supplier/logistics.                              |
| `PROOF_SUBMITTED` | Supplier/logistics has uploaded proof (IPFS CID). Awaiting buyer confirmation.                 |
| `CONFIRMED`       | Buyer has confirmed the milestone. Payment is released. Terminal state for this milestone.     |
| `DISPUTED`        | Buyer disputes the submitted proof. Arbiter must review and resolve.                           |
| `RESOLVED`        | Arbiter has resolved the dispute. Payment distribution is final. Terminal state.               |

### Transitions

#### PENDING → PROOF_SUBMITTED

**Trigger**: Supplier or logistics uploads proof via `POST /shipments/:id/milestones/:index/proof`.

**Side Effects**:
- `status` set to `PROOF_SUBMITTED`
- `proofHash` (IPFS CID) recorded
- Buyer notified (email + push notification)
- `ProofSubmission` record created with submitter, file size, and SHA-256 hash

**Requirements**:
- Milestone must be in `PENDING` status
- File must be PDF, image (PNG, JPEG, GIF, WebP), or MP4
- Shipment must be `ACTIVE` (not `CANCELLED` or `COMPLETED`)

#### PROOF_SUBMITTED → CONFIRMED

**Trigger**: Buyer calls `POST /shipments/:id/milestones/:index/confirm`.

**Side Effects**:
- `status` set to `CONFIRMED`
- `confirmedAt` timestamp recorded
- Payment (`paymentPercent` of `totalAmount`) released to supplier
- `paymentReleased` field populated
- Supplier notified (email + push)
- `PAYMENT_RELEASED` notification created

**Requirements**:
- Only the **buyer** may confirm
- Milestone must be in `PROOF_SUBMITTED` status
- Shipment must not be `CANCELLED`
- If shipment requires co-approvals (`requiredApprovals > 0`), the shipment must have sufficient `ShipmentApproval` records

#### PROOF_SUBMITTED → DISPUTED

**Trigger**: Buyer calls `POST /shipments/:id/milestones/:index/dispute`.

**Side Effects**:
- `status` set to `DISPUTED`
- `disputedAt` timestamp recorded
- Arbiter notified (email + push)
- Both parties may submit evidence via `POST /shipments/:id/milestones/:index/evidence`

**Requirements**:
- Milestone must be in `PROOF_SUBMITTED` status
- Caller must be the **buyer** (only buyer may dispute)

**Notes**:
- Arbiter may submit a **settlement proposal** (split payment between buyer and supplier)
- Either party may accept the settlement, or arbiter may resolve the dispute unilaterally on-chain

#### DISPUTED → RESOLVED

**Trigger**: Arbiter resolves the dispute on-chain by calling `resolve_dispute` with a ruling (percentage for supplier).

**Side Effects**:
- `status` set to `RESOLVED`
- Funds split according to arbiter's ruling
- Both parties notified (email + push)
- `DISPUTE_RESOLVED` notification created

**Requirements**:
- Milestone must be in `DISPUTED` status
- Only the **arbiter** may resolve disputes

**Notes**:
- If supplier percentage is 100%, full milestone payment goes to supplier
- If supplier percentage is 0%, full milestone payment is refunded to buyer
- Partial splits are supported (e.g., 60% to supplier, 40% to buyer)

---

## Arbiter State Machine

When a shipment is created, an arbiter is assigned. The arbiter must accept or decline their role:

```
PENDING_ACCEPTANCE ──────> ACCEPTED
                   │
                   └──────> DECLINED
```

### States

| State                 | Description                                                                         |
|-----------------------|-------------------------------------------------------------------------------------|
| `PENDING_ACCEPTANCE`  | Arbiter has been invited but has not yet responded.                                |
| `ACCEPTED`            | Arbiter has accepted the role and may resolve disputes for this shipment.          |
| `DECLINED`            | Arbiter has declined the role. Buyer must assign a new arbiter.                    |

### Transitions

#### PENDING_ACCEPTANCE → ACCEPTED

**Trigger**: Arbiter calls `POST /arbiter/shipments/:id/accept`.

**Side Effects**:
- `arbiterStatus` set to `ACCEPTED`
- Buyer and supplier notified
- `ARBITER_ACCEPTED` notification created

#### PENDING_ACCEPTANCE → DECLINED

**Trigger**: Arbiter calls `POST /arbiter/shipments/:id/decline`.

**Side Effects**:
- `arbiterStatus` set to `DECLINED`
- Buyer notified (must assign a new arbiter)
- `ARBITER_DECLINED` notification created

**Notes**:
- If arbiter declines, buyer must update the arbiter on-chain and off-chain
- No disputes may be resolved until a new arbiter accepts

---

## Related Concepts

### Milestone Deadlines (`dueAt`)

Milestones may optionally have a `dueAt` timestamp. When the deadline passes without proof submission:

- System sends overdue notification to supplier/logistics
- `overdueNotifiedAt` is set to prevent duplicate notifications
- If milestone remains overdue for 3 days, escalation notification is sent
- `overdueReminder3dAt` is set to prevent re-escalation

**Extension Requests** (`DeadlineExtensionRequest`):
- Supplier/logistics may request an extension via `POST /shipments/:id/milestones/:index/extension-requests`
- Buyer may approve or deny via `PATCH /extension-requests/:id`
- If approved, `dueAt` is updated to the `proposedDueAt` value

### Checklist Items (`MilestoneChecklistItem`)

Buyers may define required proof items for a milestone (e.g., "Bill of Lading", "Certificate of Origin"):

- Created while milestone is `PENDING` via `POST /shipments/:id/milestones/:index/checklist`
- Supplier/logistics checks off items when uploading proof
- If `required: true` items remain incomplete, proof submission may be blocked (frontend validation)

### Settlement Proposals (`SettlementProposal`)

During a dispute, the arbiter may propose a settlement split:

```
PENDING ──────> ACCEPTED
        │
        └──────> REJECTED / WITHDRAWN
```

- Arbiter creates proposal via `POST /shipments/:id/milestones/:index/settlement-proposals`
- Either buyer or supplier may accept via `POST /settlement-proposals/:id/accept`
- Once accepted, arbiter executes on-chain resolution matching the proposal
- Rejected or withdrawn proposals have no on-chain effect

### Cancellation

Shipments may be cancelled only in `ACTIVE` status:

- Buyer or admin calls `POST /shipments/:id/cancel` (requires on-chain authorization)
- On-chain contract refunds unreleased funds to buyer
- Backend polls for `shipment_cancelled` event and updates state
- `cancelledAt`, `status = CANCELLED`, and `refundTxHash` are recorded
- Cannot confirm milestones on a cancelled shipment (enforced by `CANCELLED_SHIPMENT_CONFIRM` error)

### Archival

Completed or cancelled shipments older than 90 days (configurable) are eligible for archival:

- Cron job moves shipment + all related records (milestones, events, comments, tracking) to `ArchivedShipment`
- Original `Shipment` row is deleted
- Archived data is stored as a JSON snapshot (`payload`) for compliance/reference
- Archived shipments are read-only and accessible via separate API endpoints

---

## Example Lifecycle Flow

### Happy Path (No Dispute)

1. **Shipment created** → `status: ACTIVE`, milestones: `PENDING`
2. **Arbiter accepts** → `arbiterStatus: ACCEPTED`
3. **Supplier submits proof for milestone 0** → `milestones[0].status: PROOF_SUBMITTED`
4. **Buyer confirms milestone 0** → `milestones[0].status: CONFIRMED`, payment released
5. **Supplier submits proof for milestone 1** → `milestones[1].status: PROOF_SUBMITTED`
6. **Buyer confirms milestone 1** → `milestones[1].status: CONFIRMED`, payment released
7. **All milestones confirmed** → `status: COMPLETED`

### Dispute Path

1. **Shipment created** → `status: ACTIVE`, milestones: `PENDING`
2. **Arbiter accepts** → `arbiterStatus: ACCEPTED`
3. **Supplier submits proof for milestone 0** → `milestones[0].status: PROOF_SUBMITTED`
4. **Buyer disputes milestone 0** → `milestones[0].status: DISPUTED`
5. **Both parties submit evidence** → `DisputeEvidence` records created
6. **Arbiter proposes settlement** (60% supplier, 40% buyer) → `SettlementProposal` created
7. **Supplier accepts settlement** → proposal `status: ACCEPTED`
8. **Arbiter resolves on-chain** → `milestones[0].status: RESOLVED`, funds split 60/40
9. **Supplier submits proof for milestone 1** → `milestones[1].status: PROOF_SUBMITTED`
10. **Buyer confirms milestone 1** → `milestones[1].status: CONFIRMED`, payment released
11. **All milestones resolved/confirmed** → `status: COMPLETED`

### Cancellation Path

1. **Shipment created** → `status: ACTIVE`, milestones: `PENDING`
2. **Buyer cancels shipment on-chain** → `shipment_cancelled` event emitted
3. **Backend processes event** → `status: CANCELLED`, `cancelledAt` set, `refundTxHash` recorded
4. **No further milestone updates allowed** → API rejects confirm/dispute calls with `CANCELLED_SHIPMENT_CONFIRM` error

---

## State Validation Rules

The following invariants are enforced by the backend:

| Invariant                                  | Enforcement                                                                                   |
|--------------------------------------------|-----------------------------------------------------------------------------------------------|
| Only buyer may confirm milestones          | `ConfirmMilestoneGuard` checks `request.user.stellarAddress === shipment.buyerAddress`       |
| Only buyer may dispute milestones          | `RaiseMilestoneDisputeGuard` enforces buyer-only disputes                                     |
| Only arbiter may resolve disputes          | `ResolveDisputeGuard` checks `request.user.stellarAddress === shipment.arbiterAddress`       |
| Cannot confirm cancelled shipments         | `MilestonesService.confirmMilestone` throws `CANCELLED_SHIPMENT_CONFIRM` error               |
| Milestone must be PROOF_SUBMITTED to confirm | `MilestonesService.confirmMilestone` throws `MILESTONE_CONFIRM_STATUS` error                |
| Cannot submit proof to non-PENDING milestone | `MilestonesService.submitProof` validates status                                             |

---

## See Also

- [Architecture](../ARCHITECTURE.md) — high-level system design
- [GraphQL](./graphql.md) — queries and mutations for shipments and milestones
- [Webhooks](./webhooks.md) — subscribing to shipment lifecycle events
- [Contract Testing](./contract-testing.md) — testing smart contract interactions
- [Arbiter Reputation](./arbiter-reputation.md) — reputation system for arbiters
