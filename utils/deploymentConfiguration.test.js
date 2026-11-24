const test = require("node:test");
const assert = require("node:assert/strict");
const { readDeploymentConfiguration } = require("./deploymentConfiguration");

const base = {
  NODE_ENV: "production", APP_DEPLOYMENT_MODE: "production", MONGO_URI: "mongodb://localhost/prod_db",
  JWT_SECRET: "x".repeat(32), CORS_ALLOWED_ORIGINS: "https://uat.example.test",
  DELHIVERY_BASE_URL: "https://track.delhivery.com", DELHIVERY_API_TOKEN: "token",
  MOCK_COURIER_ADAPTER_ENABLED: "false", PORT: "3000",
};

test("accepts valid production configuration", () => {
  assert.equal(readDeploymentConfiguration(base).databaseName, "prod_db");
});

test("requires matching production mode and node environment", () => {
  assert.throws(() => readDeploymentConfiguration({ ...base, NODE_ENV: "development" }), /NODE_ENV=production/);
  assert.deepEqual(readDeploymentConfiguration({ ...base, APP_DEPLOYMENT_MODE: "uat", MONGO_URI: "mongodb://localhost/courier_testing" }).databaseName, "courier_testing");
});

test("rejects test database, missing carrier configuration and wildcard CORS", () => {
  assert.throws(() => readDeploymentConfiguration({ ...base, MONGO_URI: "mongodb://localhost/courier_testing" }), /dedicated database/);
  assert.throws(() => readDeploymentConfiguration({ ...base, DELHIVERY_API_TOKEN: "" }), /DELHIVERY_BASE_URL/);
  assert.throws(() => readDeploymentConfiguration({ ...base, CORS_ALLOWED_ORIGINS: "*" }), /exact HTTPS origins/);
});
