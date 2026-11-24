const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const createRoutes = require("./operationalSearchRoutes");

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";

function getPath(value, path) { return path.split(".").reduce((current, key) => current?.[key], value); }
function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some(branch => matches(row, branch));
    const value = getPath(row, key);
    if (expected instanceof RegExp) return expected.test(String(value ?? ""));
    if (expected && typeof expected === "object" && "$gte" in expected) {
      const actual = String(value ?? "").toLocaleLowerCase();
      return actual >= String(expected.$gte).toLocaleLowerCase() && actual < String(expected.$lt).toLocaleLowerCase();
    }
    if (Array.isArray(value)) return value.some(item => expected instanceof RegExp ? expected.test(String(item ?? "")) : String(item) === String(expected));
    return String(value ?? "") === String(expected);
  });
}
function model(rows) {
  return {
    countDocuments: async filter => rows.filter(row => matches(row, filter)).length,
    find(filter) {
      let skip = 0; let limit = 100;
      return {
        sort() { return this; }, skip(value) { skip = value; return this; }, limit(value) { limit = value; return this; },
        lean: async () => rows.filter(row => matches(row, filter)).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(skip, skip + limit),
      };
    },
  };
}

async function fixture(t, permissions) {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "operational-search-test-only";
  const rows = {
    Shipment: [
      { _id: "s1", owner: OWNER_A, waybill: "MOCK-AWB-101", record: { name: "Example Buyer", phone: "+91 98765-43210", pin: "400001" } },
      { _id: "s2", owner: OWNER_B, waybill: "MOCK-AWB-102", record: { name: "Example Buyer", phone: "9876543210", pin: "400001" } },
      { _id: "s3", owner: OWNER_A, waybill: "MOCK-AWB-103", record: { name: "example buyer", phone: "9876543211", pin: "400001" } },
    ],
    Customer: [
      { _id: "c1", owner: OWNER_A, displayName: "Example Walk-in Buyer", primaryContact: { name: "Walk In", phone: "98765 43210" } },
      { _id: "c2", owner: OWNER_B, displayName: "Example Other", primaryContact: { phone: "9876543210" } },
    ],
    Address: [{ _id: "a1", owner: OWNER_A, partyType: "CONSIGNEE", companyName: "Example Recipient", contactName: "Recipient", phone: "+91-9876543210", pincode: "400001" }],
    Pickup: [{ _id: "p1", owner: OWNER_A, carrierRequestId: "PICKUP-101", warehouse: "Example warehouse", location: { phone: "9876543210", pincode: "400001" } }],
    Ndr: [{ _id: "n1", owner: OWNER_A, waybill: "MOCK-AWB-101", reference: "ORDER-101", customer: "Example Buyer", status: "OPEN" }],
    Rto: [{ _id: "r1", owner: OWNER_A, originalWaybill: "MOCK-AWB-101", originalReference: "ORDER-101", status: "RTO", lifecycleState: "ACTIVE" }],
  };
  const models = Object.fromEntries(Object.entries(rows).map(([name, data]) => [name, model(data)]));
  const app = express();
  if (permissions) app.use((req, res, next) => { req.authz = { permissions }; next(); });
  app.use("/search", createRoutes({ models }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  async function request(query = "", { owner = OWNER_A, token = true } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/search${query}`, { headers });
    return { status: response.status, body: await response.json() };
  }
  return { request, rows };
}

test("searches owner shipments by AWB prefix and returns typed results", async t => {
  const { request } = await fixture(t);
  const result = await request("?q=MOCK-AWB-10");
  assert.equal(result.status, 200);
  assert.equal(result.body.data.items.filter(item => item.type === "SHIPMENT").length, 2);
  assert.ok(result.body.data.items.every(item => item.target));
  assert.ok(result.body.data.items.every(item => item.id !== "s2"));
});

test("search excludes records and counts outside the user's read permissions", async t => {
  const { request } = await fixture(t, ["search.read", "shipments.read"]);
  const response = await request("?q=MOCK-AWB-101");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.items.map(item => item.type), ["SHIPMENT"]);
  assert.equal(response.body.data.total, 1);
});

test("searches customer names case-insensitively and by partial prefix", async t => {
  const { request } = await fixture(t);
  const result = await request("?q=example%20wAlK");
  assert.equal(result.body.data.items.find(item => item.type === "CUSTOMER")?.id, "c1");
});

test("normalizes international and formatted mobile numbers without exposing other owners", async t => {
  const { request } = await fixture(t);
  const result = await request("?q=%2B91%2098765-43210");
  assert.ok(result.body.data.items.some(item => item.type === "CUSTOMER" && item.id === "c1"));
  assert.ok(result.body.data.items.some(item => item.type === "ADDRESS" && item.id === "a1"));
  assert.ok(result.body.data.items.every(item => item.id !== "c2" && item.id !== "s2"));
});

test("searches exact validated pincodes across shipment, address, and pickup records", async t => {
  const { request } = await fixture(t);
  const result = await request("?q=400001");
  assert.deepEqual(new Set(result.body.data.items.map(item => item.type)), new Set(["SHIPMENT", "ADDRESS", "PICKUP"]));
  assert.ok(result.body.data.items.every(item => item.id !== "s2"));
});

test("AWB search includes associated NDR and RTO records", async t => {
  const { request } = await fixture(t);
  const result = await request("?q=MOCK-AWB-101");
  assert.ok(result.body.data.items.some(item => item.type === "NDR" && item.id === "n1"));
  assert.ok(result.body.data.items.some(item => item.type === "RTO" && item.id === "r1"));
});

test("paginates every result source, honors max limits, and rejects invalid query and page parameters", async t => {
  const { request, rows } = await fixture(t);
  for (let i = 0; i < 12; i++) rows.Shipment.push({ _id: `sx${i}`, owner: OWNER_A, waybill: `MOCK-AWB-X${String(i).padStart(2, "0")}`, record: { name: "Example" } });
  const first = await request("?q=MOCK-AWB-X&limit=6&page=1");
  const second = await request("?q=MOCK-AWB-X&limit=6&page=2");
  assert.equal(first.body.data.items.length, 6);
  assert.equal(second.body.data.items.length, 6);
  assert.equal(new Set([...first.body.data.items, ...second.body.data.items].map(item => item.id)).size, 12);
  assert.equal((await request("?q=MOCK-AWB-X&limit=61")).status, 400);
  assert.equal((await request("?q=MOCK-AWB-X&page=101")).status, 400);
  assert.equal((await request("?q=12")).status, 400);
  assert.equal((await request("?q=%21%21%21")).status, 400);
  assert.equal((await request("?q=1")).status, 400);
});

test("empty results are a successful empty page and access requires authentication", async t => {
  const { request } = await fixture(t);
  const empty = await request("?q=NoSuchRecord");
  assert.equal(empty.status, 200); assert.deepEqual(empty.body.data.items, []); assert.equal(empty.body.data.total, 0);
  assert.equal((await request("?q=buyer", { token: false })).status, 401);
});

