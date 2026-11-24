const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DELHIVERY_FEATURES, isDelhiveryFeatureEnabled, anyDelhiveryFeatureEnabled } = require("./delhiveryFeatureFlags");
const { readDeploymentConfiguration } = require("./deploymentConfiguration");

test("production credentials enable supported operations by default and explicit false disables them", () => {
  const env = {};
  for (const feature of Object.keys(DELHIVERY_FEATURES)) {
    assert.equal(isDelhiveryFeatureEnabled(feature, env), false, `${feature} is off without production configuration`);
  }
  assert.equal(anyDelhiveryFeatureEnabled({}), false);
  const production = { APP_DEPLOYMENT_MODE: "production", DELHIVERY_BASE_URL: "https://carrier.example.test", DELHIVERY_API_TOKEN: "test-token", MOCK_COURIER_ADAPTER_ENABLED: "false", DELHIVERY_WEBHOOK_AUTHORIZATION: "test-webhook" };
  for (const feature of Object.keys(DELHIVERY_FEATURES)) {
    assert.equal(isDelhiveryFeatureEnabled(feature, production), feature === "PICKUP_STATUS" ? false : true, feature);
    assert.equal(isDelhiveryFeatureEnabled(feature, { ...production, [DELHIVERY_FEATURES[feature]]: "false" }), false, `${feature} explicit false`);
  }
  assert.equal(anyDelhiveryFeatureEnabled(production), true);
});

test("UAT and mock mode preserve individually enabled reads and block outbound carrier mutations", () => {
  const environment = {
    APP_DEPLOYMENT_MODE: "uat",
    MOCK_COURIER_ADAPTER_ENABLED: "true",
    ...Object.fromEntries(Object.values(DELHIVERY_FEATURES).map(name => [name, "true"])),
  };
  assert.equal(isDelhiveryFeatureEnabled("PINCODE_SERVICEABILITY", environment), true);
  assert.equal(isDelhiveryFeatureEnabled("TRACKING", environment), true);
  assert.equal(isDelhiveryFeatureEnabled("SHIPPING_COST", environment), true);
  assert.equal(isDelhiveryFeatureEnabled("TRACKING_WEBHOOK", environment), true);
  assert.equal(isDelhiveryFeatureEnabled("TRACKING", { ...environment, DELHIVERY_TRACKING_ENABLED: "false" }), false);
  for (const feature of ["WAYBILL_ALLOCATION", "SHIPMENT_BOOKING", "SHIPMENT_UPDATE", "SHIPMENT_CANCELLATION", "PICKUP_CREATION", "NDR_OPERATIONS"]) {
    assert.equal(isDelhiveryFeatureEnabled(feature, environment), false);
    assert.equal(isDelhiveryFeatureEnabled(feature, { ...environment, MOCK_COURIER_ADAPTER_ENABLED: "false" }), false);
    assert.equal(isDelhiveryFeatureEnabled(feature, { ...environment, APP_DEPLOYMENT_MODE: undefined }), false);
  }
});

test("configured production credentials supply defaults while UAT remains opt-in", () => {
  const env = {
    APP_DEPLOYMENT_MODE: "production", MOCK_COURIER_ADAPTER_ENABLED: "false", COURIER_DELHIVERY_ADAPTER_ENABLED: "false",
    DELHIVERY_API_TOKEN: "test-token", DELHIVERY_BASE_URL: "https://carrier.example.test",
  };
  assert.equal(isDelhiveryFeatureEnabled("PINCODE_SERVICEABILITY", env), true);
  assert.equal(isDelhiveryFeatureEnabled("PINCODE_SERVICEABILITY", { ...env, DELHIVERY_PINCODE_SERVICEABILITY_ENABLED: "false" }), false);
  assert.equal(isDelhiveryFeatureEnabled("SHIPPING_COST", env), true);
  assert.equal(isDelhiveryFeatureEnabled("SHIPPING_COST", { ...env, DELHIVERY_SHIPPING_COST_ENABLED: "false" }), false);
  assert.equal(isDelhiveryFeatureEnabled("PINCODE_SERVICEABILITY", { ...env, DELHIVERY_API_TOKEN: "" }), false);
  assert.equal(isDelhiveryFeatureEnabled("PINCODE_SERVICEABILITY", { ...env, DELHIVERY_BASE_URL: "http://carrier.example.test" }), false);
  assert.equal(isDelhiveryFeatureEnabled("SHIPPING_COST", { ...env, DELHIVERY_API_TOKEN: "" }), false);
  assert.equal(isDelhiveryFeatureEnabled("SHIPPING_COST", { ...env, DELHIVERY_BASE_URL: "http://carrier.example.test" }), false);
  assert.equal(isDelhiveryFeatureEnabled("SHIPMENT_BOOKING", env), true);
  assert.equal(isDelhiveryFeatureEnabled("SHIPMENT_BOOKING", { ...env, APP_DEPLOYMENT_MODE: "uat" }), false);
});

test("hosted deployment validates database isolation before connecting and rejects invalid origins", () => {
  const env = {
    NODE_ENV: "production", APP_DEPLOYMENT_MODE: "uat",
    JWT_SECRET: "test-only-not-a-production-value-long-enough",
    CORS_ALLOWED_ORIGINS: "https://uat.example.test",
    MONGO_URI: "mongodb+srv://dummy:dummy@cluster.example.test/courier_testing?retryWrites=true",
  };
  assert.deepEqual(readDeploymentConfiguration(env), { databaseName: "courier_testing", port: 3000 });
  assert.throws(() => readDeploymentConfiguration({ ...env, APP_DEPLOYMENT_MODE: "production" }), /dedicated database/);
  assert.throws(() => readDeploymentConfiguration({ ...env, MONGO_URI: env.MONGO_URI.replace("courier_testing", "wrongdb") }), /courier_testing/);
  assert.throws(() => readDeploymentConfiguration({ ...env, MONGO_URI: "mongodb://localhost" }), /courier_testing/);
  assert.throws(() => readDeploymentConfiguration({ ...env, CORS_ALLOWED_ORIGINS: "*" }), /exact HTTPS origins/);
  assert.throws(() => readDeploymentConfiguration({ ...env, CORS_ALLOWED_ORIGINS: "https://uat.example.test/" }), /exact HTTPS origins/);
  assert.throws(() => readDeploymentConfiguration({ ...env, APP_DEPLOYMENT_MODE: undefined }), /APP_DEPLOYMENT_MODE/);
});
