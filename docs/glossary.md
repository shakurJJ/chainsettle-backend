# Glossary

Definitions of core domain terms as used in this codebase. These are not generic dictionary
definitions — they reflect the precise meaning of each term within ChainSettle's supply-chain
escrow model.

---

## Shipment

A single escrow agreement between a buyer and a supplier for the movement of goods. A
shipment is created on-chain via the ChainSettle Soroban contract and then registered in the
database by the backend. It holds the total locked amount (in USDC stroops), the four
participant addresses, and a list of one or more milestones.

A shipment has three possible statuses: `ACTIVE` (in progress), `COMPLETED` (all milestones
confirmed), or `CANCELLED` (buyer or contract cancelled before completion).

**Implemented in:** `src/modules/shipments/` · `prisma/schema.prisma` (`model Shipment`)

---

## Milestone

One discrete deliverable within a shipment, each carrying a percentage of the total payment.
Milestones are stored in the database with a 0-based `milestoneIndex` that mirrors the
on-chain index. Payment is only released when the buyer confirms the milestone on-chain.

Milestone statuses in order of progression:

| Status | Meaning |
|--------|---------|
| `PENDING` | Work has not started or proof has not been submitted |
| `PROOF_SUBMITTED` | Supplier or logistics provider has uploaded a proof document |
| `CONFIRMED` | Buyer confirmed the milestone; payment released on-chain |
| `DISPUTED` | Buyer raised a dispute instead of confirming |
| `RESOLVED` | Arbiter resolved the dispute |

**Implemented in:** `src/modules/milestones/` · `prisma/schema.prisma` (`model Milestone`)

---

## Arbiter

A neutral third party designated at shipment creation to resolve disputes between the buyer
and supplier. The arbiter address is locked into the on-chain contract and cannot be changed
after creation. An arbiter must explicitly accept or decline the assignment
(`ArbiterStatus`: `PENDING_ACCEPTANCE` → `ACCEPTED` or `DECLINED`). The backend tracks each
arbiter's history (disputes handled, disputes open, average resolution time) as a
**reputation** score, cached in Redis and refreshed by `ArbiterReputationJob`.

**Implemented in:** `src/modules/arbiters/` · `src/modules/shipments/shipments.controller.ts`
(`POST /shipments/:id/arbiter/accept`, `POST /shipments/:id/arbiter/decline`)

---

## Proof

A document (PDF, image, or video) uploaded by the supplier or logistics participant as
evidence that a milestone has been completed. Proofs are pinned to IPFS via Pinata; only the
resulting IPFS CID (Content Identifier) is stored in the database on the `Milestone` record
as `proofHash`. Each upload is also recorded in the `ProofSubmission` table so the full
submission history for a milestone is preserved.

Uploading a proof moves the milestone from `PENDING` to `PROOF_SUBMITTED` and triggers a
notification to the buyer.

**Implemented in:** `src/modules/milestones/milestones.controller.ts`
(`POST /shipments/:id/milestones/:index/proof`) · `src/common/ipfs/`

---

## Dispute

When a buyer receives a proof but disagrees that the milestone is complete, they raise a
dispute on-chain. The on-chain event moves the milestone status to `DISPUTED` in the
database. Both the buyer and the supplier can then submit dispute evidence
(`DisputeEvidence`) — files and descriptions — for the arbiter to review. The dispute
remains `DISPUTED` until the arbiter resolves it, transitioning the milestone to `RESOLVED`.

**Implemented in:** `src/modules/milestones/milestones.service.ts` ·
`prisma/schema.prisma` (`model DisputeEvidence`)

---

## Escalation

When a dispute has remained in `DISPUTED` status for longer than `DISPUTE_ESCALATION_DAYS`
(default 7 days) without resolution, the `DisputeEscalationJob` sends a `SYSTEM_ALERT`
notification to all admin users and sets `disputeEscalatedAt` on the milestone to prevent
repeated alerts. Escalation is automatic and does not change the milestone status — it only
alerts admins that the dispute needs attention.

**Implemented in:** `src/modules/milestones/dispute-escalation.job.ts`

---

## Reconciliation

A weekly background job (`ReconciliationJob`) that compares the on-chain state of every
`ACTIVE` shipment with the state stored in the database. If a mismatch ("state drift") is
detected — for example, the contract shows a shipment as `COMPLETED` but the DB still shows
it as `ACTIVE` — the job:

1. Alerts all admin users with a `SYSTEM_ALERT` notification describing the drift.
2. If the on-chain status is terminal (`COMPLETED` or `CANCELLED`), auto-corrects the DB
   record by calling `syncStatusFromChain`.

Each run is recorded in the `ReconciliationRun` table with counts of shipments checked,
mismatches found, and any errors. The job runs every Sunday at 02:00 UTC.

**Implemented in:** `src/modules/events/reconciliation.job.ts` ·
`prisma/schema.prisma` (`model ReconciliationRun`)

---

## Reputation

A per-arbiter performance snapshot computed from their dispute history: total disputes
handled (resolved), currently open disputes, and average time from dispute creation to
resolution in hours. The snapshot is computed by `ArbitersService.computeReputation()`,
cached in Redis under `arbiter:reputation:<address>`, and refreshed on a scheduled basis by
`ArbiterReputationJob`. The first call for a brand-new arbiter computes the score live as a
fallback.

**Implemented in:** `src/modules/arbiters/arbiters.service.ts` ·
`src/modules/arbiters/arbiter-reputation.job.ts`
