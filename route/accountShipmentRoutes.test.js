const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const routes = require("./accountShipmentRoutes");
let server, base;
const previousSecret = process.env.JWT_SECRET;
before(async () => {
  process.env.JWT_SECRET = "isolated-test-secret-not-a-production-credential";
  const app = express();
  app.use("/api/delhivery", routes);
  server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  base = `http://127.0.0.1:${server.address().port}/api/delhivery/shipments`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});
const token = (options = {}) => jwt.sign({ id: "test-user" }, process.env.JWT_SECRET, { expiresIn: "1h", ...options });
test("missing, invalid and expired sessions are rejected", async () => {
  for (const value of [null, "bad-token", token({ expiresIn: -1 })]) {
    const response = await fetch(base, { headers: value ? { Authorization: `Bearer ${value}` } : {} });
    assert.equal(response.status, 401);
  }
});
test("authenticated request reports unavailable, never an empty account", async () => {
  const response = await fetch(base, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.code, "SHIPMENT_LIST_SOURCE_REQUIRED");
  assert.equal(body.shipments, undefined);
  assert.equal(JSON.stringify(body).includes(process.env.JWT_SECRET), false);
});
test("pagination is bounded and validated", async () => {
  for (const query of ["page=0", "page=1.5", "page=1&page=2", "limit=101", "limit=-1"]) {
    const response = await fetch(`${base}?${query}`, { headers: { Authorization: `Bearer ${token()}` } });
    assert.equal(response.status, 400);
  }
});
