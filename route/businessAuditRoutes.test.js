const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const createRoutes = require("./businessAuditRoutes");

test("business audit endpoint requires authentication and returns only the session owner's events", async t => {
  const previous = process.env.JWT_SECRET; process.env.JWT_SECRET = "business-audit-route-test-only";
  const rows = [
    { _id: "event-a", ownerId: "owner-a", actorId: "owner-a", action: "customer.created", entityType: "CUSTOMER", entityRef: "c1", outcome: "SUCCEEDED", statusCode: 201, changedFields: ["displayName"], correlationId: "corr-a", createdAt: new Date("2026-01-02"), method: "GET", operationPath: "/c/api/pin-codes/json/", durationMs: 12, privateData: "excluded" },
    { _id: "event-b", ownerId: "owner-b", actorId: "owner-b", action: "shipment_draft.created", entityType: "SHIPMENT_DRAFT", entityRef: "d1", outcome: "SUCCEEDED", statusCode: 201, changedFields: [], correlationId: "corr-b", createdAt: new Date("2026-01-01") },
  ];
  const queries = [];
  const AuditModel = { find(filter) {
    queries.push(filter);
    let result = rows.filter(row => row.ownerId === filter.ownerId);
    return { sort() { result = [...result].sort((a, b) => b.createdAt - a.createdAt); return this; }, skip(count) { result = result.slice(count); return this; }, limit(count) { result = result.slice(0, count); return this; }, select() { return this; }, lean: async () => result };
  } };
  const app = express(); app.use("/audit", createRoutes({ AuditModel, IntegrationModel: AuditModel }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  async function request(path, owner) {
    const token = owner ? jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" }) : "";
    const response = await fetch(`http://127.0.0.1:${server.address().port}/audit${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request("/", null)).status, 401);
  const result = await request("/?page=1&limit=10", "owner-a");
  assert.equal(result.status, 200);
  assert.deepEqual(queries.at(-1), { ownerId: "owner-a" });
  assert.equal(result.body.data.events.length, 1);
  assert.equal(result.body.data.events[0].id, "event-a");
  assert.equal("ownerId" in result.body.data.events[0], false);
  assert.equal((await request("/?page=0", "owner-a")).status, 400);
  assert.equal((await request("/integrations", null)).status, 401);
  const integrations = await request("/integrations", "owner-a");
  assert.equal(integrations.status, 200);
  assert.deepEqual(integrations.body.data.events.map(row => row.id), ["event-a"]);
  assert.equal(integrations.body.data.events[0].operationPath, "/c/api/pin-codes/json/");
  assert.equal(integrations.body.data.events[0].durationMs, 12);
  assert.equal("privateData" in integrations.body.data.events[0], false);
});

