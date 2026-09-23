const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const makeRouter = require("../services/appShipmentRouter");

// In-memory repository only in tests; production uses the Mongoose model.
async function fixture(t) {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "shipment-tests-only";
  const rows = [];
  const flags = { calls: 0, dbDown: false, saveFail: false, reject: false, timeout: false };
  const matches = (row, query) => Object.entries(query).every(([k, v]) => row[k] === v);
  const db = () => { if (flags.dbDown) throw new Error("database unavailable"); };
  const Shipment = {
    init: async () => db(),
    findOne: async (q) => { db(); return rows.find(r => matches(r, q)); },
    create: async (data) => { db(); const row = { ...data, _id: String(rows.length + 1), createdAt: new Date() }; rows.push(row); return row; },
    countDocuments: async (q) => { db(); return rows.filter(r => matches(r, q)).length; },
    find(q) {
      let skip = 0, limit = 100;
      return { sort() { return this; }, skip(n) { skip = n; return this; }, limit(n) { limit = n; return this; },
        async lean() { db(); return rows.filter(r => matches(r, q)).slice(skip, skip + limit); } };
    },
    updateOne: async (q, update) => {
      if (flags.saveFail) throw new Error("save failed");
      const row = rows.find(r => matches(r, q));
      for (const [k, v] of Object.entries(update.$set)) {
        if (k.startsWith("record.")) row.record[k.slice(7)] = v;
        else row[k] = v;
      }
    },
    deleteOne: async (q) => { const index = rows.findIndex(r => matches(r, q)); if (index >= 0) rows.splice(index, 1); },
  };
  const carrier = { post: async (url) => {
    flags.calls++;
    if (flags.timeout) throw new Error("timeout");
    if (flags.response) return { data: flags.response };
    if (flags.reject) return { data: { success: false, packages: [{ status: "Fail" }] } };
    return { data: url.includes("create") ? { success: true, packages: [{ waybill: "TEST-WAYBILL", status: "Success" }] } : { status: true } };
  } };
  const app = express(); app.use(express.json()); app.use(makeRouter({ Shipment, carrier }));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  });
  const request = async (path, owner = "user-a", body) => {
    const token = owner && jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const create = () => request("/shipments", "user-a", { shipments: [{ order: "ORDER-1", name: "Recipient", weight: "500", total_amount: "100", payment_mode: "Prepaid" }], pickup_location: { name: "Hub" } });
  return { request, create, flags, rows };
}
test("requires authentication and validates pagination", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/shipments", null)).status, 401);
  for (const q of ["page=0", "limit=101", "page=1&page=2", "page=9007199254740991"]) assert.equal((await f.request(`/shipments?${q}`)).status, 400);
});
test("creation persists normalized data, survives a new login and isolates owners", async t => {
  const f = await fixture(t);
  assert.equal((await f.create()).status, 201);
  const own = await f.request("/shipments?page=1&limit=1");
  assert.equal(own.body.data.total, 1);
  assert.equal(own.body.data.shipments[0].weight, 0.5);
  assert.equal(own.body.data.source, "app-created");
  assert.equal((await f.request("/shipments", "user-b")).body.data.total, 0);
  assert.equal((await f.request("/shipments?page=2&limit=1")).body.data.shipments.length, 0);
  assert.equal((await f.create()).status, 200);
  assert.equal(f.flags.calls, 1);
});
test("database outage is not a genuine empty state and blocks carrier creation", async t => {
  const f = await fixture(t); f.flags.dbDown = true;
  assert.equal((await f.request("/shipments")).status, 503);
  assert.equal((await f.create()).status, 503);
  assert.equal(f.flags.calls, 0);
});
test("provider rejection never creates a saved shipment", async t => {
  const f = await fixture(t); f.flags.reject = true;
  assert.equal((await f.create()).status, 502);
  assert.equal((await f.request("/shipments")).body.data.total, 0);
});
test("uncertain carrier response prevents duplicate submission", async t => {
  const f = await fixture(t); f.flags.timeout = true;
  assert.equal((await f.create()).status, 502);
  assert.equal((await f.create()).status, 409);
  assert.equal(f.flags.calls, 1);
});

test("partial-save rejection retains the reservation and blocks duplicate carrier calls", async t => {
  const f = await fixture(t);
  f.flags.response = {
    success: false,
    rmk: "An internal Error has occurred, Please get in touch with client.support@delhivery.com",
    packages: [{ waybill: "", status: "Fail", err_code: "ER0005", remarks: [
      "Crashing while saving package due to exception suspicious order/consignee. Package might have been partially saved."
    ] }],
  };
  const first = await f.create();
  assert.equal(first.status, 502);
  assert.equal(first.body.data.packages[0].err_code, "ER0005");
  assert.equal(f.rows.length, 1);
  assert.equal((await f.create()).status, 409);
  assert.equal(f.flags.calls, 1);
  assert.equal((await f.request("/shipments")).body.data.total, 0);
});

test("explicit rejection without partial-save warnings allows a corrected submission", async t => {
  const f = await fixture(t); f.flags.reject = true;
  assert.equal((await f.create()).status, 502);
  f.flags.reject = false;
  assert.equal((await f.create()).status, 201);
  assert.equal(f.flags.calls, 2);
});
test("post-carrier save failure reports the real waybill and prevents duplicate submission", async t => {
  const f = await fixture(t); f.flags.saveFail = true;
  const response = await f.create();
  assert.equal(response.body.code, "SHIPMENT_SAVE_FAILED");
  assert.equal(response.body.waybill, "TEST-WAYBILL");
  assert.equal((await f.create()).status, 409);
  assert.equal(f.flags.calls, 1);
});
test("updates and cancellations are owner-scoped and persist only after acceptance", async t => {
  const f = await fixture(t); await f.create();
  assert.equal((await f.request("/shipments/cancel", "user-b", { waybill: "TEST-WAYBILL" })).status, 404);
  f.flags.reject = true;
  assert.equal((await f.request("/shipments/cancel", "user-a", { waybill: "TEST-WAYBILL" })).status, 502);
  assert.equal(f.rows[0].record.status, "Pending pickup");
  f.flags.reject = false;
  await f.request("/shipments/update", "user-a", { waybill: "TEST-WAYBILL", city: "Delhi", pin: "110001" });
  await f.request("/shipments/cancel", "user-a", { waybill: "TEST-WAYBILL" });
  const row = (await f.request("/shipments")).body.data.shipments[0];
  assert.equal(row.status, "Cancelled"); assert.equal(row.destination, "Delhi");
});
