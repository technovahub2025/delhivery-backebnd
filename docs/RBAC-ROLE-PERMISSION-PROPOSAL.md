# RBAC proposal â€” pending client approval

SRD V1.0 Â§16 requires secure login, role-based access control, and user permissions. It does not define role names, permission boundaries, tenant-wide administration, or a migration policy. The roles and matrix below are proposals only; they are not client-approved assignments.

## Proposed role matrix

All permissions below are granular API capabilities from `config/rbacPermissions.js`. The Administrator role is shown with the complete set as a proposal, not as a default assignment.

| Capability | Administrator (proposed) | Operations (proposed) | Booking (proposed) | Finance (proposed) |
| --- | --- | --- | --- | --- |
| Dashboard | `dashboard.read` | `dashboard.read` | `dashboard.read` | `dashboard.read` |
| Customers / addresses / rate cards | all `customers.*`, `party_addresses.*`, `rate_cards.*` | `customers.read`, `party_addresses.read` | `customers.read`, `party_addresses.read`, `rate_cards.read` | `customers.read`, `rate_cards.read` |
| Shipment booking and AWB | all `shipments.*`, `waybills.generate`, `reverse_orders.*` | `shipments.read`, `shipments.update`, `shipments.cancel`, `shipments.ewaybill`, `reverse_orders.read` | `shipments.read`, `shipments.book`, `shipments.update`, `shipments.cancel`, `shipments.ewaybill`, `shipments.drafts.manage`, `shipments.quote`, `waybills.generate`, `reverse_orders.read`, `reverse_orders.create` | `shipments.read` |
| Pickup scheduling | all `pickup_requests.*` | all `pickup_requests.*` | `pickup_requests.read`, `pickup_requests.schedule` | `pickup_requests.read` |
| Tracking / NDR / RTO | all `tracking.*`, `ndr.*`, `rto.*` | all `tracking.*`, `ndr.*`, `rto.*` | `tracking.read`, `ndr.read`, `rto.read` | `tracking.read`, `ndr.read`, `rto.read` |
| Invoices and payments | all `billing.*` | `billing.read` | `billing.read` | all `billing.*` |
| Partner cost / financial reports | `partner_costs.read`, `partner_costs.reconcile`, `finance.reports.read` | `partner_costs.read` | `partner_costs.read` | `partner_costs.read`, `partner_costs.reconcile`, `finance.reports.read` |
| Warehouse management | `warehouses.read`, `warehouses.create`, `warehouses.update` | same | same | `warehouses.read` |
| Delhivery lookup / label / document | `delhivery.lookups`, `delhivery.labels.read`, `delhivery.documents.read` | same | same | `delhivery.lookups`, `delhivery.documents.read` |
| Scheduled reports | `scheduled_reports.read`, `scheduled_reports.manage` | `scheduled_reports.read` | `scheduled_reports.read` | `scheduled_reports.read`, `scheduled_reports.manage` |
| User / permission administration | `users.read`, `users.permissions.manage` | â€” | â€” | â€” |

The permission catalog includes `warehouses.read` for a future owner-scoped warehouse listing. No warehouse-list API currently exists. The existing create/update endpoints use `warehouses.create` and `warehouses.update`.

## Current enforcement behavior

- Enforcement is controlled by the exact environment value `RBAC_ENFORCEMENT_ENABLED=true`. If the variable is absent or has any other value, RBAC authorization is in compatibility mode and the application follows its prior authenticated flow. Existing JWT authentication, route-level `requireSession` checks, and owner filters remain in force. This is the default for development; no environment file is changed by this implementation.
- The RBAC administration API still requires an authenticated session and permission-bearing `req.authz`, so it cannot grant roles while enforcement is disabled. Bootstrap remains a separately gated, explicit one-time operation.
- When `RBAC_ENFORCEMENT_ENABLED=true`, the enforcement behavior below applies:
  - No active `RbacPolicy` record means RBAC is pending and protected API calls fail closed with `RBAC_POLICY_PENDING` (503).
  - A user without a configured `roleKey` receives 403. New registrations have no role. Existing users with no role remain unassigned.
  - Login retains the existing JWT claims and response fields, adding `role`, `permissions`, and `authorizationStatus` to its user object. Permissions are not trusted from JWT claims.
  - Each protected request loads the current user role and current policy from MongoDB. Role changes take effect immediately, including for previously issued JWTs.
  - Business records continue to be filtered by the authenticated owner in their existing route/service logic. RBAC permissions do not grant cross-owner shipment/customer/financial data access.
  - The API boundary maps exact HTTP methods and route templates to permissions; unknown paths and unsupported methods are denied as `rbac.unmapped`. Only `POST /api/auth/login`, `POST /api/auth/register`, and `POST /api/delhivery/webhook` are explicit exemptions. The webhook remains under its separate fail-closed signature configuration.
  - Role assignment and policy updates require an existing account with `users.permissions.manage`, require a reason, prevent self-role changes, prevent grants beyond the actor's own permissions, and create auditable before/after records.
  - The one-time `scripts/bootstrapRbac.js` path requires an explicit approval flag/reference, a supplied approved policy, a single selected user, a role with permission-management authority, an unassigned active account, and a MongoDB transaction. It is not run as part of this implementation.

## Client decisions required before activation

1. Approve, change, or reject the proposed role names and permission matrix.
2. Confirm the user-management boundary. The current User model has no organization/tenant field, so administrator role management spans all login users in this database.
3. Approve the migration policy and identify exactly one initial permission administrator, or specify an alternate bootstrap process. Existing users will not be auto-assigned.
4. Confirm whether role assignments are single-role (the current implementation) or users may hold multiple roles.
5. Confirm whether an administrator may grant any role within their own permission ceiling, and whether an additional approver is required for privileged changes.
6. Confirm retention and access requirements for the RBAC audit trail.

Until decisions 1–3 are approved, keep `RBAC_ENFORCEMENT_ENABLED` unset or set it to `false`. This preserves the normal authenticated application flow while RBAC configuration remains pending. The frontend currently uses a fixed navigation tree and does not consume permission metadata; backend enforcement remains authoritative.

## Activation after client approval

Do not enable enforcement against an absent or pending policy: protected APIs will correctly fail closed. After the client approves the role matrix, migration policy, initial administrator, and user-management boundary:

1. In the controlled administrative environment, provide the approved policy as `RBAC_APPROVED_ROLE_POLICY_JSON`, set `RBAC_APPROVAL_REFERENCE` and `RBAC_BOOTSTRAP_APPROVED=true`, and use the approved database connection.
2. Run the one-time bootstrap with the specifically approved account ID and role key: `node scripts/bootstrapRbac.js <approved-user-object-id> <approved-role-key>`. It installs the policy and assigns that one account transactionally; it refuses to overwrite an existing policy or role.
3. Verify the policy and initial assignment through the audited workflow, then set `RBAC_ENFORCEMENT_ENABLED=true` in the intended application environment and restart the backend.
4. To return to compatibility mode during an approved rollback, unset the variable or set it to `false`; this does not remove policy or role data.

No bootstrap, role assignment, policy activation, or production configuration change is part of this implementation task.
