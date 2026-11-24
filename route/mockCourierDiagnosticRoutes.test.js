const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const createDiagnosticRoutes = require("./mockCourierDiagnosticRoutes");
const { createShipmentPartnerRegistry } = require("../services/shipmentPartnerRegistry");

async function fixture(t, { nodeEnv = "development", mockEnabled = "true", delhiveryEnabled = "false", readyState = 1, databaseName = "courier_testing", authenticate = true } = {}) {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "diagnostic-test-secret";
  const env = {
    NODE_ENV: nodeEnv,
    MOCK_COURIER_ADAPTER_ENABLED: mockEnabled,
    DELHIVERY_SHIPMENT_BOOKING_ENABLED: delhiveryEnabled,
    JWT_SECRET: "must-not-be-returned",
    MONGO_URI: "mongodb://user:password@example.invalid/secret-db",
    DELHIVERY_API_TOKEN: "must-not-be-returned-either",
  };
  const mongooseInstance = { connection: { readyState, name: databaseName } };
  const partnerRegistry = createShipmentPartnerRegistry({ mongooseInstance, getEnvironment: () => env });
  const app = express();
  app.use("/api/diagnostics", createDiagnosticRoutes({ partnerRegistry, mongooseInstance, getEnvironment: () => env }));
  const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  const token = jwt.sign({ id: "aaaaaaaaaaaaaaaaaaaaaaaa" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/diagnostics/mock-courier`, {
    headers: authenticate ? { Authorization: `Bearer ${token}` } : {},
  });
  return { response, env, mongooseInstance, partnerRegistry };
}

test("diagnostic reports enabled mock from the active runtime registry and connection", async t => {
  const { response, partnerRegistry } = await fixture(t);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    nodeEnv: "development",
    mockCourierAdapterEnabled: true,
    delhiveryAdapterEnabled: false,
    mongoConnectionState: 1,
    connectedDatabaseName: "courier_testing",
    registeredAdapterNames: partnerRegistry.list().map(adapter => adapter.name),
  });
  assert.deepEqual(body.registeredAdapterNames, ["Local mock courier (no carrier request)"]);
  assert.equal(JSON.stringify(body).includes("must-not-be-returned"), false);
  assert.equal(JSON.stringify(body).includes("mongodb://"), false);
});

test("diagnostic shows no registered adapter when mock is disabled", async t => {
  const { response } = await fixture(t, { mockEnabled: "false" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mockCourierAdapterEnabled, false);
  assert.deepEqual(body.registeredAdapterNames, []);
});

test("diagnostic shows no mock adapter for the wrong active database", async t => {
  const { response } = await fixture(t, { databaseName: "other_database" });
  const body = await response.json();
  assert.equal(body.connectedDatabaseName, "other_database");
  assert.deepEqual(body.registeredAdapterNames, []);
});

test("disconnected MongoDB reports state and no connected database or mock adapter", async t => {
  const { response } = await fixture(t, { readyState: 0, databaseName: "courier_testing" });
  const body = await response.json();
  assert.equal(body.mongoConnectionState, 0);
  assert.equal(body.connectedDatabaseName, null);
  assert.deepEqual(body.registeredAdapterNames, []);
});

test("diagnostic endpoint is not registered in production", async t => {
  const { response } = await fixture(t, { nodeEnv: "production" });
  assert.equal(response.status, 404);
});

test("diagnostic endpoint requires an authenticated session", async t => {
  const { response } = await fixture(t, { authenticate: false });
  assert.equal(response.status, 401);
});
