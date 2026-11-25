# Admin Impersonation for Support

This document describes how admin impersonation works in the system, the safeguards that constrain it, and how impersonated actions are recorded for auditors.

Impersonation is a sensitive capability. It allows a privileged administrator to act **as** another user in order to reproduce and resolve support issues. Because it can be used to access user data or perform actions on a user's behalf, its limits must be clear to both the admins who use it and the auditors who review it.

---

## 1. Starting and Ending an Impersonation Session

### Starting a session

Impersonation is an **admin-only** flow. Only users holding the appropriate administrative role can initiate it.

1. An administrator authenticates normally and obtains a standard access token.
2. The administrator requests an impersonation session for a target user (for example, via the admin support endpoint).
3. The backend validates that the caller is an administrator and that the target user exists and is eligible for impersonation.
4. The backend issues a **new access token** for the target user. This token carries an `isImpersonation` flag set to `true`, along with the identity of the impersonating administrator.

The resulting token is scoped to the impersonated user's permissions — it does **not** inherit the administrator's privileges. The administrator acts with exactly the rights of the target user, minus the actions blocked below.

### Session scope and expiry

- **Scoped:** An impersonation token is valid only for the impersonated user's session. It cannot be used to perform administrative operations.
- **Time-limited:** Impersonation tokens have a short expiry. When the token expires, the session ends and the administrator must re-initiate impersonation if further support work is required.
- **Explicit end:** The administrator can end the session at any time by discarding the impersonation token and returning to their own session. Ending a session does not affect the impersonated user's own sessions.

Administrators should end impersonation sessions as soon as the support task is complete rather than leaving them open.

---

## 2. Actions Blocked While Impersonating

Certain sensitive actions are prohibited while impersonating, even if the impersonated user would normally be permitted to perform them. These actions are marked at the route level with the `@BlockImpersonation()` decorator.

Examples of blocked actions include:

- **Changing the account email address**
- **Deleting the account**

The set of blocked actions is defined by the routes decorated with `@BlockImpersonation()`. When new sensitive endpoints are added, they should be evaluated for inclusion.

### Enforcement

Blocking is enforced centrally by the `ImpersonationGuard`. For every request to a route protected by `@BlockImpersonation()`, the guard inspects the authenticated request:

- If `request.user.isImpersonation` is `true`, the guard throws a `ForbiddenException` and the action is rejected.
- If the request is a normal (non-impersonated) session, the request proceeds as usual.

This means blocked actions cannot be bypassed by the impersonated user's own permissions — the guard rejects the request regardless of what the target user is otherwise allowed to do.

---

## 3. Audit Attribution

Every action performed during an impersonation session is recorded in the audit log with **both** identities:

- the **impersonated user** (whose account the action appears to affect), and
- the **impersonating administrator** (who actually performed the action).

Audit entries for impersonated actions are explicitly flagged as impersonation events. This allows auditors to:

- distinguish genuine actions taken by a user from support actions taken on their behalf, and
- trace any impersonated action back to the specific administrator responsible.

Administrators must assume that everything they do while impersonating is attributable to them personally and is subject to review.

---

## 4. Security Considerations

- **Least privilege.** Impersonation tokens carry only the target user's permissions, never the administrator's. Use impersonation only for the specific support task at hand.
- **Session expiry.** Impersonation sessions are short-lived by design. Do not attempt to extend or persist them beyond their intended scope; re-initiate a fresh session if more work is needed.
- **Audit review.** Impersonation audit entries should be reviewed regularly by auditors or security staff. Unexpected or unexplained impersonation activity should be investigated.
- **No destructive actions.** Impersonation must **never** be used to perform destructive or irreversible actions (such as deleting an account or changing account-recovery details). These actions are blocked by `@BlockImpersonation()` and `ImpersonationGuard`; attempting to circumvent these controls is a policy violation.
- **Accountability.** Because actions are attributed to the impersonating administrator, impersonation is not anonymous. Treat every impersonated session as one that will be audited.
- **Report abuse.** Any suspected misuse of impersonation should be reported to the security team immediately.