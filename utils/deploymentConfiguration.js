const { mongo: { MongoClient } } = require("mongoose");

function readDeploymentConfiguration(env = process.env) {
  const mode = env.APP_DEPLOYMENT_MODE;
  const hosted = Boolean(mode) || env.NODE_ENV === "production";
  if (mode === "production" && env.NODE_ENV !== "production") {
    throw new Error("Production deployments require NODE_ENV=production.");
  }
  if (hosted && !["uat", "production"].includes(mode)) {
    throw new Error("APP_DEPLOYMENT_MODE must be uat or production.");
  }
  let databaseName;
  try {
    if (!env.MONGO_URI) throw new Error();
    databaseName = new MongoClient(env.MONGO_URI).db().databaseName;
  } catch {
    throw new Error("MONGO_URI must contain a valid MongoDB connection string.");
  }
  if (mode !== "production" && databaseName !== "courier_testing") {
    throw new Error("Development and UAT require courier_testing in MONGO_URI.");
  }
  if (mode === "production" && (["courier_testing", "test"].includes(databaseName) ||
      env.MOCK_COURIER_ADAPTER_ENABLED === "true")) {
    throw new Error("Production requires a dedicated database and mock mode disabled.");
  }
  if (mode === "production" && (!env.DELHIVERY_BASE_URL || !env.DELHIVERY_API_TOKEN)) {
    throw new Error("Production requires DELHIVERY_BASE_URL and DELHIVERY_API_TOKEN.");
  }
  if (!env.JWT_SECRET || (hosted && env.JWT_SECRET.trim().length < 32)) {
    throw new Error("JWT_SECRET is required and must have at least 32 characters for hosted deployments.");
  }
  if (env.DELHIVERY_INTEGRATION_LOG_RETENTION_DAYS &&
      (!/^\d{1,4}$/.test(env.DELHIVERY_INTEGRATION_LOG_RETENTION_DAYS) ||
       Number(env.DELHIVERY_INTEGRATION_LOG_RETENTION_DAYS) < 1 ||
       Number(env.DELHIVERY_INTEGRATION_LOG_RETENTION_DAYS) > 3650)) {
    throw new Error("DELHIVERY_INTEGRATION_LOG_RETENTION_DAYS must be between 1 and 3650.");
  }
  if (mode === "production" && !env.CORS_ALLOWED_ORIGINS) {
    throw new Error("Production requires CORS_ALLOWED_ORIGINS with exact HTTPS origins.");
  }
  if (hosted && env.CORS_ALLOWED_ORIGINS) {
    for (const origin of env.CORS_ALLOWED_ORIGINS.split(",").map(value => value.trim())) {
      let url;
      try { url = new URL(origin); } catch { /* Reject invalid origins below. */ }
      if (origin === "*" || url?.protocol !== "https:" || url.origin !== origin) {
        throw new Error("CORS_ALLOWED_ORIGINS must contain exact HTTPS origins.");
      }
    }
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
  return { databaseName, port };
}

module.exports = { readDeploymentConfiguration };
