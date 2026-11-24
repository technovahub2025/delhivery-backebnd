const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const createRoutes = require("./partnerCostRoutes");

const OWNER_A = "partner-cost-owner-a";
const OWNER_B = "partner-cost-owner-b";
const SHIPMENT_ID = "64a000000000000000000001";
const JWT_SECRET = "partner-cost-test-secret";
const id = value => new mongoose.Types.ObjectId(value);
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function getPath(row, path) { return path.split(".").reduce((value, key) => value?.[key], row); }
function matches(row, filter) { return Object.entries(filter).every(([key, value]) => {
  const actual = getPath(row, key);
  if (actual instanceof Date || value instanceof Date) return new Date(actual).getTime() === new Date(value).getTime();
  return String(actual ?? "") === String(value ?? "");
}); }

function fixture(t) {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = JWT_SECRET;
  t.after(() => { if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret; });
  const rows = [
    { _id: id(SHIPMENT_ID), owner: OWNER_A, state: "saved", kind: "forward", reference: "DUMMY-ORDER-1", waybill: "MOCK-AWB-1", createdAt: new Date("2026-09-05T00:00:00Z"), updatedAt: new Date("2026-09-05T00:00:00Z"), record: { partnerCode: "MOCK_CARRIER", partnerName: "Mock Carrier", bookingStatus: "AWB_GENERATED", estimatedPartnerCostSnapshot: { amount: "125.50", currency: "INR", source: "PARTNER_QUOTE", quoteId: "quote-dummy-1", capturedAt: "2026-09-05T00:00:00Z", chargeBreakdown: { baseFreight: "100.00", fuelSurcharge: "25.50" } }, partnerQuoteSnapshot: { id: "quote-dummy-1", partnerTotal: "125.50", currency: "INR" } } },
    { _id: id("64a000000000000000000002"), owner: OWNER_A, state: "saved", kind: "forward", reference: "DUMMY-ORDER-2", createdAt: new Date("2026-09-06T00:00:00Z"), updatedAt: new Date("2026-09-06T00:00:00Z"), record: { partnerCode: "MOCK_CARRIER", bookingStatus: "AWB_GENERATED" } },
    { _id: id("64a000000000000000000003"), owner: OWNER_B, state: "saved", kind: "forward", reference: "PRIVATE-ORDER", record: { partnerCode: "MOCK_CARRIER", estimatedPartnerCostSnapshot: { amount: "900", currency: "INR" } } },
  ];
  const Shipment = {
    find(filter) {
      let found = rows.filter(row => matches(row, filter));
      const query = { sort() { found = [...found].reverse(); return query; }, limit() { return query; }, lean: async () => clone(found) };
      return query;
    },
    findOne(filter) { return { lean: async () => clone(rows.find(row => matches(row, filter)) || null) }; },
    findOneAndUpdate(filter, update) {
      const row = rows.find(candidate => matches(candidate, filter));
      if (row) {
        for (const [path, value] of Object.entries(update.$set || {})) {
          const parts = path.split("."); let parent = row;
          for (const part of parts.slice(0, -1)) parent = parent[part] ||= {};
          parent[parts.at(-1)] = clone(value);
        }
        row.updatedAt = new Date(row.updatedAt.getTime() + 1);
      }
      return { lean: async () => clone(row || null) };
    },
  };
  const app = express(); app.use(express.json()); app.use((req, res, next) => { req.correlationId = req.get("X-Request-ID") || null; next(); }); app.use("/partner-costs", createRoutes({ Shipment, now: () => new Date("2026-10-01T12:00:00Z") }));
  const server = app.listen(0);
  t.after(() => server.close());
  async function request(path, { owner = OWNER_A, token = true, method = "GET", body, correlationId } = {}) {
    const address = server.address();
    return fetch(`http://127.0.0.1:${address.port}/partner-costs${path}`, {
      method, headers: { ...(token ? { Authorization: `Bearer ${jwt.sign({ id: owner }, JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" })}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...(correlationId ? { "X-Request-ID": correlationId } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).then(async response => ({ status: response.status, body: await response.json() }));
  }
  return { rows, request };
}

const finalBody = { amount: "130.75", currency: "INR", sourceReference: "DUMMY-INVOICE-REF-1", invoiceDate: "2026-09-30", chargeBreakdown: { baseFreight: "100.00", fuelSurcharge: "25.75", taxesAndGst: "5.00", total: "130.75" }, taxBasis: { treatment: "provider invoice basis supplied" }, notes: "dummy test invoice" };

test("lists pending and unavailable estimates with filters, and requires authentication", async t => {
  const f = fixture(t);
  assert.equal((await f.request("/", { token: false })).status, 401);
  const all = await f.request("/");
  assert.equal(all.status, 200);
  assert.equal(all.body.data.costs.length, 2);
  assert.equal(all.body.data.costs.find(row => row.reference === "DUMMY-ORDER-1").reconciliationStatus, "PENDING");
  assert.equal(all.body.data.costs.find(row => row.reference === "DUMMY-ORDER-2").reconciliationStatus, "UNAVAILABLE");
  assert.equal((await f.request("/?status=PENDING&partnerCode=mock_carrier")).body.data.costs.length, 1);
});

test("persists authoritative final cost separately, preserves estimate, breakdown, tax basis and audit", async t => {
  const f = fixture(t);
  const response = await f.request(`/${SHIPMENT_ID}/final`, { method: "POST", body: finalBody, correlationId: "partner-correlation-1" });
  assert.equal(response.status, 201);
  const cost = response.body.data.cost;
  assert.equal(cost.estimatedCost.amount, "125.5");
  assert.equal(cost.finalCost.amount, "130.75");
  assert.equal(cost.reconciliationStatus, "DISCREPANT");
  assert.equal(cost.variance, "5.25");
  assert.equal(cost.finalCost.gstRecoverability, null);
  assert.deepEqual(cost.finalCost.chargeBreakdown, { baseFreight: "100", fuelSurcharge: "25.75", taxesAndGst: "5", total: "130.75" });
  assert.deepEqual(cost.finalCost.taxBasis, finalBody.taxBasis);
  assert.equal(cost.reconciliationHistory.length, 1);
  assert.equal(cost.costAuditTrail[0].action, "FINAL_COST_RECORDED_AND_RECONCILED");
  assert.equal(cost.costAuditTrail[0].correlationId, "partner-correlation-1");
  const stored = f.rows[0].record;
  assert.equal(stored.estimatedPartnerCostSnapshot.amount, "125.50");
  assert.equal(stored.partnerCostSnapshot.sourceReference, finalBody.sourceReference);
});

test("supports equal and different-currency comparisons; blocks duplicate or unreferenced final cost", async t => {
  const f = fixture(t);
  const equal = await f.request(`/${SHIPMENT_ID}/final`, { method: "POST", body: { ...finalBody, amount: "125.50", chargeBreakdown: undefined } });
  assert.equal(equal.body.data.cost.reconciliationStatus, "CONFIRMED");
  const duplicate = await f.request(`/${SHIPMENT_ID}/final`, { method: "POST", body: finalBody });
  assert.equal(duplicate.status, 409);
  const noReference = await f.request("/64a000000000000000000002/final", { method: "POST", body: { amount: "4", currency: "INR" } });
  assert.equal(noReference.status, 400);
  assert.equal(f.rows[1].record.partnerCostSnapshot, undefined);
});

test("records an explicitly confirmed recoverable GST amount and rejects an amount above the invoice tax", async t => {
  const f = fixture(t);
  const path = `/${SHIPMENT_ID}/final`;
  const rejected = await f.request(path, { method: "POST", body: { ...finalBody, gstRecoverability: "6" } });
  assert.equal(rejected.status, 400);
  const accepted = await f.request(path, { method: "POST", body: { ...finalBody, gstRecoverability: "0" } });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.data.cost.finalCost.gstRecoverability, "0");
});

test("prevents cross-owner detail and final-cost access and keeps estimate-only shipments non-final", async t => {
  const f = fixture(t);
  assert.equal((await f.request(`/${SHIPMENT_ID}`, { owner: OWNER_B })).status, 404);
  assert.equal((await f.request(`/${SHIPMENT_ID}/final`, { owner: OWNER_B, method: "POST", body: finalBody })).status, 404);
  const detail = await f.request("/64a000000000000000000002");
  assert.equal(detail.body.data.cost.finalCost, null);
  assert.equal(detail.body.data.cost.reconciliationStatus, "UNAVAILABLE");
});

test("concurrent final-cost submissions have a single winner", async t => {
  const f = fixture(t);
  const [one, two] = await Promise.all([
    f.request(`/${SHIPMENT_ID}/final`, { method: "POST", body: finalBody }),
    f.request(`/${SHIPMENT_ID}/final`, { method: "POST", body: { ...finalBody, sourceReference: "DUMMY-INVOICE-REF-2" } }),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [201, 409]);
  assert.equal(f.rows[0].record.partnerCostReconciliations.length, 1);
});

test("rejects invalid breakdown and malformed date filters", async t => {
  const f = fixture(t);
  assert.equal((await f.request(`/${SHIPMENT_ID}/final`, { method: "POST", body: { ...finalBody, chargeBreakdown: { mystery: "1" } } })).status, 400);
  assert.equal((await f.request("/?from=not-a-date")).status, 400);
});
