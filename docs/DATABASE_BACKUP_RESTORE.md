# MongoDB backup and restore runbook

## What this repository can verify

The application reads `MONGO_URI` to connect to MongoDB. This repository contains no hosting definition, managed database snapshot integration, backup schedule, backup storage configuration, or database operator credentials. Hosting-side snapshots and automated retention therefore need confirmation from the deployment owner. The application does not expose backup or restore routes, and `createBackupMetadata()` only creates a validated, secret-free metadata record; it does not run a database command or claim that a backup exists.

## Prerequisites for the deployment owner

- Identify the actual MongoDB provider, deployment environment, database identifier, approved maintenance window, and provider-supported backup tooling.
- Obtain an approved backup/restore plan, retention duration, recovery point objective, recovery time objective, and named operators.
- Store the MongoDB URI in the hosting secret manager or a protected client configuration file readable only by the operator. Never put it in command arguments, shell history, tickets, logs, this repository, or backup metadata.
- Use encrypted storage with restricted access and retention/deletion controls. Record the backup artifact checksum and storage reference in the operator system of record; do not put credentials or full URIs in metadata.
- Verify that backup tooling and storage are available before scheduling any backup. This runbook does not imply infrastructure support.

## Backup procedure (operator-run only)

1. Confirm environment and target database through the provider console and approved change record. Do not infer the target from a developer workstation.
2. Generate a unique backup ID and a `STARTED` metadata entry using the actual environment/database identifier and UTC creation time.
3. Use the provider's supported consistent snapshot/backup mechanism. If provider-approved MongoDB Database Tools are used, supply credentials through a protected config file or secret manager integration, not on the command line. Direct the archive to encrypted, access-controlled storage; do not save it in the source tree.
4. Verify command exit status, artifact existence, nonzero size, checksum, and provider/tool integrity verification. Record only a bounded safe failure code (for example `BACKUP_TOOL_FAILED`), never raw stderr that may include a URI.
5. Mark metadata `COMPLETED` with a UTC completion timestamp only after verification; otherwise mark `FAILED`. Include the backup ID, timestamps, environment/database identifier, status, and sanitized failure code. Keep the artifact and metadata under the same retention/access policy.

## Restore procedure and approval boundary

An ordinary application user cannot trigger a restore: there is no application endpoint or permission for it. A production restore requires explicit client/incident-owner approval, a documented recovery plan, a named infrastructure operator, a verified backup, a maintenance window, and a rollback plan. Never restore over production as an exploratory test.

1. Start with a fresh, isolated **non-production** MongoDB database/project with separate credentials and network restrictions. Confirm its target name and ensure no production URI is present in the restore process.
2. Select a completed backup, verify its checksum/integrity and metadata, and record the verification activity. Use provider-supported tooling and an isolated target; if using `mongorestore`, use namespace remapping to a fresh test database rather than `--drop` or the source namespace.
3. Validate connectivity, expected collections/indexes, representative document counts, application startup against the isolated target, and key read-only workflows. Do not send provider requests or create bookings/payments/invoices as part of verification.
4. Have a second authorized operator review results. Keep the test target isolated, then remove it according to approved retention policy. Record outcome and evidence without secrets.
5. A production restore is a separate approved recovery operation. Confirm the exact source/target, point-in-time, data-loss impact, backups of the current state where feasible, application write freeze, and rollback steps before execution. The application does not implement or automate this operation.

## Metadata format

The tested helper returns only `backupId`, `createdAt`, `environment`, `databaseIdentifier`, `status`, optional `completedAt`, and a sanitized optional `failureCode`. It intentionally excludes URIs, credentials, raw command output, and document data. Metadata is not proof of an artifact; operators must link it to a separately controlled artifact/checksum record.
