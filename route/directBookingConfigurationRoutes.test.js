const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const createRoutes = require("./directBookingConfigurationRoutes");

async function fixture(t, { nodeEnv = "test", delhiveryEnabled, authenticate = true } = {}) {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "direct-booking-config-tests-only";
  const env = { NODE_ENV: nodeEnv, DELHIVERY_SHIPMENT_BOOKING_ENABLED: delhiveryEnabled };
  const app = express();
  app.use("/api/config", createRoutes({ getEnvironment: () => env }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const token = jwt.sign({ id: "aaaaaaaaaaaaaaaaaaaaaaaa" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/config/direct-booking`, {
    headers: authenticate ? { Authorization: `Bearer ${token}` } : {},
  });
  return response;
}

test("authenticated configuration reports direct booking enabled only for the exact true flag", async t => {
  const response = await fixture(t, { delhiveryEnabled: "true" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { directBookingEnabled: true });
});

test("authenticated configuration reports direct booking disabled for a false flag", async t => {
  const response = await fixture(t, { delhiveryEnabled: "false" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { directBookingEnabled: false });
});

test("missing Delhivery flag reports direct booking disabled", async t => {
  const response = await fixture(t);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { directBookingEnabled: false });
});

test("configuration endpoint rejects unauthenticated requests", async t => {
  const response = await fixture(t, { delhiveryEnabled: "true", authenticate: false });
  assert.equal(response.status, 401);
});

test("configuration endpoint is available in production configuration", async t => {
  const response = await fixture(t, { nodeEnv: "production", delhiveryEnabled: "true" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { directBookingEnabled: true });
});
