const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DELHIVERY_FEATURES, isDelhiveryFeatureEnabled, anyDelhiveryFeatureEnabled } = require("./delhiveryFeatureFlags");
const { readDeploymentConfiguration } = require("./deploymentConfiguration");

test("every Delhivery operation has an independent, exact-true opt-in and defaults off", () => {
  const env = {};
  for (const feature of Object.keys(DELHIVERY_FEATURES)) {
    assert.equal(isDelhiveryFeatureEnabled(feature, env), false, `${feature} defaults off`);
    env[DELHIVERY_FEATURES[feature]] = "true";
    assert.equal(isDelhiveryFeatureEnabled(feature, env), true, `${feature} enables independently`);
    for (const other of Object.keys(DELHIVERY_FEATURES)) {
      if (other !== feature) assert.equal(isDelhiveryFeatureEnabled(other, { [DELHIVERY_FEATURES[feature]]: "true" }), false, `${feature} does not enable ${other}`);
    }
    env[DELHIVERY_FEATURES[feature]] = "TRUE";
    assert.equal(isDelhiveryFeatureEnabled(feature, env), false, `${feature} requires exact true`);
    env[DELHIVERY_FEATURES[feature]] = "true";
  }
  assert.equal(anyDelhiveryFeatureEnabled({}), false);
  assert.equal(anyDelhiveryFeatureEnabled(env), true);
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

test("configured credentials supply automatic defaults only for standard pincode and shipping-cost reads", () => {
  const env = {
    MOCK_COURIER_ADAPTER_ENABLED: "true", COURIER_DELHIVERY_ADAPTER_ENABLED: "false",
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
  for (const feature of Object.keys(DELHIVERY_FEATURES).filter(name => !["PINCODE_SERVICEABILITY", "SHIPPING_COST"].includes(name))) {
    assert.equal(isDelhiveryFeatureEnabled(feature, env), false, feature);
  }
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
