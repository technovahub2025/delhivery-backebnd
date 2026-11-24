const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const createDashboardController = require("../controller/dashboardController");

test("overview route authenticates, scopes all model reads to the session owner and filters dates", async t => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "dashboard-tests-only";
  const queries = [];
  const model = { find(query) { queries.push(query); return { lean: async () => [] }; } };
  const controller = createDashboardController({ Shipment: model, PickupRequest: model, NdrCase: model, RtoRecord: model });
  const app = express();
  app.get("/dashboard/overview", ...controller.getOverview);
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  const base = `http://127.0.0.1:${server.address().port}/dashboard/overview`;
  assert.equal((await fetch(base)).status, 401);
  const token = jwt.sign({ id: "fixture-owner", exp: Math.floor(Date.now() / 1000) + 60 }, process.env.JWT_SECRET);
  const response = await fetch(`${base}?from=2026-09-01&to=2026-09-30`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.data.metrics.totalShipments, 0);
  assert.equal(queries.length, 4);
  assert.ok(queries.every(query => query.owner === "fixture-owner"));
  assert.equal((await fetch(`${base}?from=not-a-date`, { headers: { Authorization: `Bearer ${token}` } })).status, 400);
});
