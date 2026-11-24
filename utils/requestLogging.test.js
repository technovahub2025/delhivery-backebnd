const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createRequestLogger } = require("./requestLogging");
const { requestContext } = require("./requestLogging");
const { createIntegrationLogger } = require("./delhiveryIntegrationLogging");

test("provider logging records bounded owner-scoped metadata and omits credentials and carrier identifiers", async () => {
  const entries = [];
  const record = createIntegrationLogger({
    Event: { create: async entry => entries.push(entry) }, databaseReady: () => true,
    environment: { DELHIVERY_INTEGRATION_LOG_ENABLED: "true", DELHIVERY_INTEGRATION_LOG_RETENTION_DAYS: "30" },
    now: () => 1000,
  });
  const config = { method: "get", url: "/api/cmu/get_bulk_upl/private-id", headers: { Authorization: "private-token" }, params: { waybill: "private-waybill" } };
  requestContext.run({ user: { id: "owner-a" }, correlationId: "abc" }, () => record(config, 980, 503, true));
  await Promise.resolve();
  assert.deepEqual(entries, [{
    ownerId: "owner-a", correlationId: "abc", method: "GET", operationPath: "/api/cmu/get_bulk_upl/:uplId",
    durationMs: 20, statusCode: 503, outcome: "HTTP_ERROR", expiresAt: new Date(1000 + 30 * 86400000),
  }]);
});

test("logs successful requests with safe route, duration and a correlated request ID", async t => {
  const records = [];
  let clock = 10;
  const app = express();
  app.use(createRequestLogger({ logger: { info: value => records.push(value), warn() {}, error() {} }, now: () => clock++ }));
  app.get("/api/shipments/:id", (req, res) => res.json({ success: true }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const id = "d26a8a31-0f93-4f4d-8d09-46e7f6a33311";
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/shipments/123?token=hidden`, { headers: { "X-Request-ID": id, Authorization: "Bearer hidden-token" } });
  assert.equal(response.headers.get("x-request-id"), id);
  assert.equal(response.status, 200);
  const log = JSON.parse(records[0]);
  assert.equal(log.correlationId, id);
  assert.equal(log.method, "GET"); assert.equal(log.route, "/api/shipments/:id");
  assert.equal(log.statusCode, 200); assert.equal(log.durationMs, 1);
  assert.equal(records.join("").includes("hidden"), false);
});

test("logs safe error codes and does not break responses when logger throws", async t => {
  const records = [];
  const app = express();
  app.use(createRequestLogger({ logger: { info() {}, warn: value => records.push(value), error: () => { throw new Error("logger failure"); } } }));
  app.post("/api/customers", (req, res) => res.status(400).json({ success: false, code: "CUSTOMER_INPUT_INVALID", message: "contains private details" }));
  app.get("/api/failure", (req, res) => res.status(500).json({ success: false, code: "INTERNAL_ERROR", secret: "never log this" }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const clientError = await fetch(`http://127.0.0.1:${server.address().port}/api/customers`, { method: "POST" });
  assert.equal(clientError.status, 400);
  const serverError = await fetch(`http://127.0.0.1:${server.address().port}/api/failure`);
  assert.equal(serverError.status, 500);
  const event = JSON.parse(records[0]);
  assert.equal(event.errorCode, "CUSTOMER_INPUT_INVALID");
  assert.equal(records.join("").includes("private details"), false);
  assert.equal(records.join("").includes("never log this"), false);
});

test("untrusted non-UUID request IDs are replaced before response or logging", async t => {
  const records = [];
  const app = express();
  app.use(createRequestLogger({ logger: { info: value => records.push(value), warn() {}, error() {} } }));
  app.get("/safe", (req, res) => res.json({ success: true }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/safe`, { headers: { "X-Request-ID": "this-is-a-token-do-not-log" } });
  assert.notEqual(response.headers.get("x-request-id"), "this-is-a-token-do-not-log");
  assert.equal(records.join("").includes("this-is-a-token-do-not-log"), false);
});

