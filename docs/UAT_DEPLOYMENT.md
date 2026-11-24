# Isolated Courier Management UAT

Run the backend with `npm start`. Set `NODE_ENV` to production and `APP_DEPLOYMENT_MODE` to uat. Development and UAT require the explicitly named `courier_testing` database in `MONGO_URI` before startup connects. Use a distinct database principal scoped to that database. Designate a separate database and principal for production, where startup rejects the UAT database. Credit billing and payment allocation require a replica set or transaction-capable managed MongoDB.

The process begins listening after MongoDB connection and model initialization. Probe `GET /health/live` for process liveness and `GET /health/ready` for MongoDB readiness. Serve the frontend over HTTPS. Build it with `npm run build`, then either proxy same-origin `/api` to the isolated backend or supply `VITE_API_BASE_URL` and let the backend allow the exact frontend origin. A blank URL uses the current browser origin. Auth uses bearer tokens and browser session storage. Use an isolated signing secret and operator account.

## Environment variable names

| Purpose | Names |
| --- | --- |
| Backend startup | `NODE_ENV`, `APP_DEPLOYMENT_MODE`, `MONGO_URI`, `JWT_SECRET`, `PORT` (platform or default), `HOST` (optional bind address) |
| Frontend and CORS | `VITE_API_BASE_URL`, `CORS_ALLOWED_ORIGINS` (required for split-origin frontend) |
| Account provisioning and authorization | `AUTH_REGISTRATION_ENABLED`, `RBAC_ENFORCEMENT_ENABLED`. One-time RBAC tooling uses `RBAC_BOOTSTRAP_APPROVED`, `RBAC_APPROVAL_REFERENCE`, `RBAC_APPROVED_ROLE_POLICY_JSON`. |
| Demo adapters and samples | `MOCK_COURIER_ADAPTER_ENABLED`, `MOCK_COURIER_SAMPLE_AWB_ENABLED`, `MOCK_COURIER_SAMPLE_PINCODES`, `MOCK_COURIER_SURFACE_SAMPLE`, `MOCK_COURIER_EXPRESS_SAMPLE`, `DEMO_WALK_IN_PAYMENT_METHODS` |
| Optional manual walk-in receipts | `WALK_IN_RECEIPT_METHODS` (comma-separated approved method labels; unset disables the manual receipt workflow) |
| Carrier access and purpose-specific controls | `DELHIVERY_BASE_URL`, `DELHIVERY_API_TOKEN`, plus the [exact per-capability names](DELHIVERY_FEATURE_FLAGS.md) |
| Carrier booking configuration when separately authorized | `DELHIVERY_CLIENT_NAME`, `DELHIVERY_RETURN_ADDRESS`, `DELHIVERY_RETURN_CITY`, `DELHIVERY_RETURN_NAME`, `DELHIVERY_RETURN_PHONE`, `DELHIVERY_RETURN_PIN`, `DELHIVERY_RETURN_STATE`, `DELHIVERY_SELLER_GST_TIN` |
| Webhooks, polling and notifications | `DELHIVERY_WEBHOOK_AUTHORIZATION`, `DELHIVERY_TRACKING_POLL_ENABLED`, `DELHIVERY_TRACKING_POLL_MINUTES`, `DELHIVERY_TRACKING_UTC_OFFSET`, `COURIER_STATUS_MAPPINGS_JSON`, `OPERATIONAL_NOTIFICATION_TYPES` |
| Retained outbound carrier metadata | `DELHIVERY_INTEGRATION_LOG_ENABLED`, `DELHIVERY_INTEGRATION_LOG_RETENTION_DAYS` |
| Optional business audit retention | `BUSINESS_AUDIT_RETENTION_DAYS` (unset preserves audit records indefinitely; if configured, use 1–3650 days) |

With retained outbound logging enabled, MongoDB records the operation path, applicable owner/request correlation, transport outcome, duration and HTTP status. Bodies, headers and query values are excluded. An optional retention period between 1 and 3650 days applies to new carrier log entries. Provider semantic outcomes are still recorded by the applicable booking, pickup or tracking workflow. Management → Audit history shows business changes and the current account's carrier requests. Background records without an authenticated owner remain accessible to the deployment operator through the database.

Business audit events are retained indefinitely by default. Set `BUSINESS_AUDIT_RETENTION_DAYS` only after the client approves the audit-history retention period. When configured to an integer from 1 through 3650, new events receive a MongoDB TTL expiry; financial invoices, payments, shipment snapshots, pickup history and case histories are separate records and are not expired by this setting. MongoDB TTL deletion is asynchronous. Invalid or absent values do not add expiry metadata.

## Sample data and acceptance

Provision a dedicated UAT account. Close public registration after provisioning. Create the sample warehouse, rate cards, addresses and two customer categories in the isolated workspace, or restore an approved sample-only backup to that database. Use the rate-card screen and sample billing settings to make a demonstration tariff explicit. See [local mock testing](LOCAL-MOCK-COURIER-TESTING.md), [credit billing configuration](credit-billing-configuration.md) and [backup and restore](DATABASE_BACKUP_RESTORE.md).

UAT mode blocks outbound carrier mutations. Real pincode serviceability can be enabled alone with configured account access. Synthetic AWBs, labels and tracking remain identifiable as local test records. Use a dedicated HTTPS callback and its configured authentication to validate [Scan Push](../WEBHOOK.md). Configure the client role policy, provider mappings, retention and transaction-backed persistence before broader acceptance. Approve actual prices, GST treatment, credit rules and receipt policy before operational use.
