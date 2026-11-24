const SAFE_STATUSES = new Set(["STARTED", "COMPLETED", "FAILED"]);

function createBackupMetadata({ backupId, createdAt = new Date(), environment, databaseIdentifier, status, completedAt = null, failureCode = null } = {}) {
  const safeId = String(backupId || "").trim();
  const safeEnvironment = String(environment || "").trim().toLowerCase();
  const safeDatabaseIdentifier = String(databaseIdentifier || "").trim();
  const safeStatus = String(status || "").trim().toUpperCase();
  const timestamp = new Date(createdAt);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(safeId)) throw new TypeError("A safe backup ID is required.");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(safeEnvironment) || !/^[A-Za-z0-9_-]{1,120}$/.test(safeDatabaseIdentifier)) throw new TypeError("Safe environment and database identifiers are required.");
  if (!SAFE_STATUSES.has(safeStatus) || !Number.isFinite(timestamp.getTime())) throw new TypeError("Backup status or timestamp is invalid.");
  const metadata = { backupId: safeId, createdAt: timestamp.toISOString(), environment: safeEnvironment, databaseIdentifier: safeDatabaseIdentifier, status: safeStatus };
  if (completedAt != null) {
    const completion = new Date(completedAt);
    if (!Number.isFinite(completion.getTime())) throw new TypeError("Backup completion timestamp is invalid.");
    metadata.completedAt = completion.toISOString();
  }
  if (safeStatus === "FAILED" && failureCode) {
    const code = String(failureCode).trim().toUpperCase();
    if (/^[A-Z0-9_-]{1,80}$/.test(code)) metadata.failureCode = code;
  }
  return Object.freeze(metadata);
}

module.exports = { createBackupMetadata };
