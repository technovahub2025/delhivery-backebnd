const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createBackupMetadata } = require("./backupMetadata");

test("backup metadata has required safe identifiers and lifecycle timestamps", () => {
  const metadata = createBackupMetadata({ backupId: "backup-test-001", createdAt: "2026-11-16T00:00:00Z", environment: "staging", databaseIdentifier: "courier_staging", status: "completed", completedAt: "2026-11-16T00:02:00Z" });
  assert.deepEqual(metadata, { backupId: "backup-test-001", createdAt: "2026-11-16T00:00:00.000Z", environment: "staging", databaseIdentifier: "courier_staging", status: "COMPLETED", completedAt: "2026-11-16T00:02:00.000Z" });
  assert.equal(Object.isFrozen(metadata), true);
});

test("failed backup metadata retains only a safe failure code, never raw details", () => {
  const metadata = createBackupMetadata({ backupId: "backup-failed", environment: "test", databaseIdentifier: "courier_testing", status: "FAILED", failureCode: "backup_tool_failed mongodb://user:secret@host" });
  assert.equal(metadata.status, "FAILED");
  assert.equal(metadata.failureCode, undefined);
  assert.equal(JSON.stringify(metadata).includes("secret"), false);
  assert.throws(() => createBackupMetadata({ backupId: "id", environment: "prod?uri=x", databaseIdentifier: "db", status: "FAILED" }), /identifiers/);
});
