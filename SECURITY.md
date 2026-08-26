# Security Policy

## Supported Versions

Only the latest commit on the `main` branch receives security fixes. No separate release tags or long-term-support branches are maintained at this time.

| Branch / Version | Supported |
|-----------------|-----------|
| `main` (latest) | ✅ Yes |
| Any older fork or snapshot | ❌ No |

## Scope

This policy covers the **ChainSettle backend** (`chainsettle-backend`) only:

- REST API surface (`/api/v1/*`)
- WebSocket gateway (`/notifications`)
- Authentication and JWT handling
- Stellar address signature verification
- PostgreSQL data handling via Prisma
- Stellar RPC / Horizon interaction code in `src/common/stellar/`

**Out of scope:**

- The Soroban smart contract — lives in the separate `chainsetttle-contract` repo. Report contract vulnerabilities there.
- The React frontend — lives in `chainsetttle-frontend`.
- Third-party dependencies (report these upstream to the relevant package maintainer; we will upgrade promptly if notified).
- Findings from automated scanners without a demonstrated impact or proof-of-concept.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

### Option 1 — GitHub Private Security Advisory (preferred)

Use GitHub's built-in private reporting:

1. Go to the **Security** tab of this repository.
2. Click **"Report a vulnerability"**.
3. Fill in the advisory form with as much detail as possible.

This keeps the report confidential and lets us collaborate on a fix before any public disclosure.

### Option 2 — Email

If you prefer email, send a report to:

**security@chainsetttle.com**

Encrypt sensitive reports with our PGP key (key ID and fingerprint will be published here once the project is in public beta).

### What to Include

A useful report typically contains:

- A clear description of the vulnerability and its potential impact
- The affected component(s) and file(s) if known
- Step-by-step reproduction instructions or a proof-of-concept
- Any suggested fix or mitigation (optional but welcome)

## Response Timeline

| Milestone | Target |
|-----------|--------|
| Acknowledgement of receipt | Within **48 hours** |
| Initial triage and severity assessment | Within **5 business days** |
| Fix development and internal testing | Within **14 days** for critical/high; **30 days** for medium/low |
| Coordinated public disclosure | After a fix is available, agreed with the reporter |

We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure). We ask reporters to give us reasonable time to produce and deploy a fix before publishing details publicly.

If we cannot meet the timelines above we will communicate that to the reporter proactively.

## Severity Guidance

We assess severity using [CVSS v3.1](https://www.first.org/cvss/v3.1/specification-document) as a baseline. Examples of what each level looks like in this project:

| Severity | Example |
|----------|---------|
| **Critical** | Authentication bypass; ability to drain escrow funds or forge milestone confirmations |
| **High** | JWT secret exposure; arbitrary Prisma query injection; private key leakage |
| **Medium** | Broken access control allowing a non-participant to read shipment data |
| **Low** | Rate-limit bypass; verbose error messages leaking internal paths |
| **Informational** | Missing security header on a non-sensitive endpoint |

## Disclosure Policy

- We will credit reporters in the release notes / advisory unless they prefer to remain anonymous.
- We will not take legal action against researchers acting in good faith under this policy.
- We ask that reporters avoid accessing, modifying, or deleting user data; performing denial-of-service attacks; or testing against accounts they do not own.
