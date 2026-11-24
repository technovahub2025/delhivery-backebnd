const { requestContext } = require("./requestLogging");

function createIntegrationLogger({ Event, databaseReady, environment = process.env, logger = console, now = Date.now }) {
  return function recordIntegrationAttempt(config, startedAt, status, failed) {
    if (environment.DELHIVERY_INTEGRATION_LOG_ENABLED !== "true" || !databaseReady()) return;
    const operationPath = config?.url?.replace(/^\/api\/cmu\/get_bulk_upl\/[^/]+$/, "/api/cmu/get_bulk_upl/:uplId");
    const method = String(config?.method || "").toUpperCase();
    if (typeof operationPath !== "string" || !/^\/[a-z0-9/_:.\-]{1,99}$/i.test(operationPath) ||
        !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return;
    const request = requestContext.getStore();
    const finishedAt = now();
    const retention = Number(environment.DELHIVERY_INTEGRATION_LOG_RETENTION_DAYS);
    const statusCode = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const record = {
      ownerId: typeof request?.user?.id === "string" ? request.user.id : null,
      correlationId: request?.correlationId || null,
      method, operationPath, statusCode,
      durationMs: Math.max(0, finishedAt - startedAt),
      outcome: failed ? (statusCode === undefined ? "TRANSPORT_ERROR" : "HTTP_ERROR") : "RESPONSE",
      ...(Number.isInteger(retention) && retention >= 1 && retention <= 3650
        ? { expiresAt: new Date(finishedAt + retention * 86400000) } : {}),
    };
    Promise.resolve().then(() => Event.create(record)).catch(() => {
      logger.warn(JSON.stringify({ event: "delhivery.integration_log", code: "PERSISTENCE_FAILED", correlationId: record.correlationId }));
    });
  };
}

module.exports = { createIntegrationLogger };
