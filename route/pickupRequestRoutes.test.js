const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const createRouter = require("../services/pickupRequestRouter");
const PickupModel = require("../model/pickupRequest");
const { validatePickupShipmentReadiness } = require("../services/pickupRequestRouter");

test("a local pickup may persist with an unspecified shipment count", async () => {
  const pickup = new PickupModel({
    owner: "test-owner", pickupDate: "2030-05-12", pickupTime: "14:30:00",
    warehouse: "Sample Warehouse", packageCount: 1, workflow: "LOCAL",
    shipmentCount: null, request: { local: true }, carrierResponse: { status: "NOT_SUBMITTED" },
  });
  await pickup.validate();
  pickup.shipmentCount = 1.5;
  await assert.rejects(pickup.validate(), { name: "ValidationError" });
});

test("pickup shipment readiness validates lifecycle, provider, ownership and warehouse", async () => {
  const base = { _id: "ship-1", owner: "owner-a", state: "saved", kind: "forward", waybill: "58063010002343", reference: "ORD-1", record: { providerCode: "DELHIVERY", providerOutcome: "PROVIDER_CONFIRMED", status: "Pending pickup", warehouse: "Chennai" } };
  const check = async (row, expected) => {
    const Shipment = { find: () => ({ select() { return this; }, lean: async () => row ? [row] : [] }) };
    const result = await validatePickupShipmentReadiness(Shipment, "owner-a", [row?.waybill || "58063010002343"], "Chennai");
    assert.equal(result[0].ok, expected, result[0].reason);
  };
  await check(base, true);
  for (const row of [
    { ...base, waybill: "" }, { ...base, waybill: "ABC" },
    { ...base, record: { ...base.record, providerOutcome: "PENDING" } },
    { ...base, record: { ...base.record, providerCode: "OTHER" } },
    { ...base, state: "draft" }, { ...base, state: "creating" },
    { ...base, kind: "reverse" }, { ...base, record: { ...base.record, status: "Cancelled" } },
    { ...base, record: { ...base.record, warehouse: "" } }, { ...base, record: { ...base.record, warehouse: "Bengaluru" } },
    { ...base, owner: "owner-b" },
  ]) await check(row, false);
  await check({ ...base, kind: undefined }, true);
});

async function fixture(t, { partnerRegistry, statusMappings = {} } = {}) {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "pickup-request-tests-only";
  const rows = [];
  const control = { bumpRevisionBeforeNextUpdate: false };
  const shipmentRows = [
    { _id: "111111111111111111111111", owner: "owner-a", state: "saved", waybill: "MOCK-AWB-1", reference: "MOCK-ORDER-1" },
    { _id: "222222222222222222222222", owner: "owner-b", state: "saved", waybill: "MOCK-AWB-2", reference: "MOCK-ORDER-2" },
  ];
  const same = (left, right) => left instanceof Date && right instanceof Date ? left.getTime() === right.getTime() : left === right;
  const matches = (row, query) => Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some(condition => Object.entries(condition).some(([field, operator]) => operator?.$in?.includes(row[field])));
    const actual = key.split(".").reduce((object, part) => object?.[part], row);
    if (value && typeof value === "object" && "$in" in value) return value.$in.includes(actual);
    if (value && typeof value === "object" && "$exists" in value) return value.$exists ? actual !== undefined && actual !== null && actual !== "" : actual === undefined;
    if (value && typeof value === "object" && "$nin" in value) return !value.$nin.includes(actual);
    return same(actual, value);
  });
  const clone = value => structuredClone(value);
  const PickupRequest = {
    find(query) { return { sort() { return this; }, limit() { return this; }, lean: async () => rows.filter(row => matches(row, query)).map(clone) }; },
    async create(data) {
      if (data.localRequestKey && rows.some(row => row.owner === data.owner && row.localRequestKey === data.localRequestKey)) {
        throw Object.assign(new Error("duplicate key"), { code: 11000 });
      }
      const row = { revision: 0, ...clone(data), _id: String(rows.length + 1).padStart(24, "0"), createdAt: new Date(), updatedAt: new Date() };
      rows.push(row);
      return clone(row);
    },
    findOne(query) { return { lean: async () => clone(rows.find(row => matches(row, query)) || null) }; },
    findOneAndUpdate(query, update) { return { lean: async () => {
      if (control.bumpRevisionBeforeNextUpdate) { rows[0].revision += 1; control.bumpRevisionBeforeNextUpdate = false; }
      const row = rows.find(item => matches(item, query));
      if (!row) return null;
      Object.assign(row, clone(update.$set), { updatedAt: new Date() });
      for (const [key, value] of Object.entries(update.$inc || {})) row[key] = Number(row[key] || 0) + Number(value);
      return clone(row);
    } }; },
    async updateOne(query, update) {
      const row = rows.find(item => matches(item, query));
      if (!row) return { matchedCount: 0 };
      Object.assign(row, clone(update.$set || {}));
      if (update.$push?.history) row.history = [...(row.history || []), clone(update.$push.history)];
      return { matchedCount: 1 };
    },
  };
  const Shipment = {
    find(query) { return { select() { return this; }, lean: async () => shipmentRows.filter(row => matches(row, query)).map(clone) }; },
  };
  const app = express(); app.use(express.json()); const mountedRouter = createRouter({ PickupRequest, Shipment, partnerRegistry, statusMappings }); app.use("/pickup-requests", mountedRouter); app.use("/api/delhivery/pickup-requests", mountedRouter);
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret; });
  const request = async (path, { owner = "owner-a", method = "GET", body, mounted = false } = {}) => {
    const token = owner && jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const response = await fetch(`http://127.0.0.1:${server.address().port}${mounted ? "/api/delhivery/pickup-requests" : "/pickup-requests"}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const input = {
    pickupDate: "2030-05-12", pickupTime: "14:30", location: { name: "Dummy Hub", contactName: "Test Contact", phone: "9000000000", email: "pickup@example.test", address: "1 Test Road", city: "Test City", state: "Test State", pincode: "400001" },
    packageCount: 2, totalWeightKg: 3.5, shipmentRefs: ["MOCK-AWB-1"],
  };
  const mountedRequest = async (id, options = {}) => request(`/${id}/submit`, { ...options, mounted: true });
  const recoverRequest = async (id, options = {}) => request(`/${id}/recover`, { ...options, mounted: true, method: "POST" });
  return { request, mountedRequest, recoverRequest, input, rows, shipmentRows, control };
}

test("pickup requests persist full location, weight, shipment links and initial status history without carrier calls", async t => {
  const f = await fixture(t);
  const result = await f.request("/", { method: "POST", body: { ...f.input, shipmentCount: 3 } });
  assert.equal(result.status, 201);
  const pickup = result.body.data.pickup;
  assert.equal(result.body.data.carrierSubmission, "NOT_CONFIGURED");
  assert.equal(pickup.location.contactName, "Test Contact");
  assert.equal(pickup.totalWeightKg, 3.5);
  assert.equal(pickup.shipmentCount, 3);
  assert.equal((await f.request(`/${pickup.id}`)).body.data.pickup.shipmentCount, 3);
  assert.equal(pickup.shipmentRefs[0].waybill, "MOCK-AWB-1");
  assert.equal(pickup.status, "Pending");
  assert.equal(pickup.history[0].action, "CREATED");
  assert.equal(f.rows[0].carrierResponse.status, "NOT_SUBMITTED");
});

test("pickup request accepts fractional kilogram weights and preserves kilograms", async t => {
  const f = await fixture(t);
  const result = await f.request("/", { method: "POST", body: { ...f.input, totalWeightKg: "0.6", shipmentRefs: [] } });
  assert.equal(result.status, 201);
  assert.equal(result.body.data.pickup.totalWeightKg, 0.6);
  assert.equal(f.rows[0].totalWeightKg, 0.6);
});

test("mounted submit endpoint is reachable at the production API path", async t => {
  const f = await fixture(t);
  const result = await f.mountedRequest("6b013fa6d1618ede086d87e9", { method: "POST", body: {} });
  assert.equal(result.status, 404); // route was reached; the fixture has no such record
  assert.equal(result.body.message, "Pickup request not found.");
});

function failedPickup(evidence, extra = {}) {
  return { _id: "6b013fa6d1618ede086d87e9", owner: "owner-a", workflow: "LOCAL", status: "Submission failed", carrierSubmissionStatus: "FAILED", revision: 2, warehouse: "Dummy Hub", pickupDate: "2030-05-12", pickupTime: "14:30:00", packageCount: 1, totalWeightKg: 0.6, shipmentRefs: [{ waybill: "58063010002343", reference: "ABC-UAT-003" }], history: [], submissionAttempt: evidence, carrierResponse: {}, ...extra };
}

test("recovery authorizes only verified safe failures and never calls the adapter", async t => {
  const adapter = { code: "DELHIVERY", createPickup: async () => { throw new Error("must not be called"); } };
  const f = await fixture(t, { partnerRegistry: { get: () => adapter } });
  f.rows.push(failedPickup({ stage: "VALIDATION", providerDispatched: false }));
  const result = await f.recoverRequest("6b013fa6d1618ede086d87e9", { body: { reason: "Reviewed local failure before dispatch" } });
  assert.equal(result.status, 200);
  assert.equal(f.rows[0].carrierSubmissionStatus, null);
  assert.equal(f.rows[0].shipmentRefs[0].waybill, "58063010002343");
  assert.equal(f.rows[0].history.at(-1).action, "CARRIER_SUBMISSION_RECOVERED");
});

test("recovery accepts an explicit provider rejection but rejects missing, timeout, submitting and confirmed evidence", async t => {
  for (const [evidence, expected] of [
    [{ stage: "PROVIDER_RESPONSE", providerDispatched: true, providerOutcome: "REJECTED", providerResponse: { status: false } }, 200],
    [{}, 409],
    [{ stage: "DISPATCH", providerDispatched: true, providerOutcome: "AMBIGUOUS" }, 409],
  ]) {
    const f = await fixture(t);
    f.rows.push(failedPickup(evidence));
    assert.equal((await f.recoverRequest("6b013fa6d1618ede086d87e9", { body: { reason: "Operator reviewed submission evidence" } })).status, expected);
  }
  for (const status of ["SUBMITTING", "OUTCOME_UNCONFIRMED", "CONFIRMED"]) {
    const f = await fixture(t);
    f.rows.push(failedPickup({ stage: "PROVIDER_RESPONSE", providerDispatched: true, providerOutcome: "REJECTED", providerResponse: { status: false } }, { status: status === "CONFIRMED" ? "Scheduled" : "Submitting", carrierSubmissionStatus: status }));
    assert.equal((await f.recoverRequest("6b013fa6d1618ede086d87e9", { body: { reason: "Operator reviewed submission evidence" } })).status, 409);
  }
});

test("recovery requires a reason and owner access", async t => {
  const f = await fixture(t); f.rows.push(failedPickup({ stage: "VALIDATION", providerDispatched: false }));
  assert.equal((await f.recoverRequest("6b013fa6d1618ede086d87e9", { body: { reason: "" } })).status, 400);
  assert.equal((await f.recoverRequest("6b013fa6d1618ede086d87e9", { owner: "owner-b", body: { reason: "Operator reviewed submission evidence" } })).status, 404);
});

test("concurrent retries create one local pickup per owner and reject changed input", async t => {
  const f = await fixture(t);
  const body = { ...f.input, shipmentRefs: [], idempotencyKey: "uat-pickup-key-unique" };
  const submit = (body, owner) => f.request("/", { method: "POST", body, owner });
  const results = await Promise.all([submit(body), submit(body)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
  assert.equal(results[0].body.data.pickup.id, results[1].body.data.pickup.id);
  assert.equal(f.rows.length, 1);
  assert.equal((await submit({ ...body, packageCount: 9 })).status, 409);
  assert.equal((await submit(body, "owner-b")).status, 201);
  assert.equal(f.rows.length, 2);
});

test("pickup request lists, details, updates and cancellations are owner scoped", async t => {
  const f = await fixture(t);
  const created = await f.request("/", { method: "POST", body: f.input });
  const id = created.body.data.pickup.id;
  assert.equal((await f.request("/")).body.data.pickups.length, 1);
  assert.equal((await f.request(`/${id}`, { owner: "owner-b" })).status, 404);
  assert.equal((await f.request(`/${id}`, { owner: "owner-a" })).body.data.pickup.id, id);
  const changed = { ...f.input, pickupDate: "2030-05-13", pickupTime: "15:00", shipmentRefs: ["MOCK-ORDER-1"] };
  const updated = await f.request(`/${id}`, { method: "PATCH", body: changed });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.pickup.date, "2030-05-13");
  assert.equal(updated.body.data.pickup.history.at(-1).action, "RESCHEDULED");
  const cancelled = await f.request(`/${id}/cancel`, { method: "POST" });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.pickup.status, "Cancelled");
  assert.equal(cancelled.body.data.pickup.history.at(-1).action, "CANCELLED");
  assert.equal((await f.request(`/${id}`, { owner: "owner-b", method: "DELETE" })).status, 404);
});

test("validates dates, times, location, package metrics and shipment ownership", async t => {
  const f = await fixture(t);
  for (const body of [
    { ...f.input, pickupDate: "2030-02-30" },
    { ...f.input, pickupTime: "25:00" },
    { ...f.input, location: { ...f.input.location, pincode: "12" } },
    { ...f.input, packageCount: 0 },
    { ...f.input, shipmentCount: 0 },
    { ...f.input, shipmentCount: 1.5 },
    { ...f.input, totalWeightKg: 0 },
    { ...f.input, shipmentRefs: ["MOCK-AWB-2"] },
    { ...f.input, shipmentRefs: "MOCK-AWB-1" },
  ]) assert.equal((await f.request("/", { method: "POST", body })).status, 400);
  assert.equal(f.rows.length, 0);
  assert.equal((await f.request("/", { owner: null })).status, 401);
});

test("cancellation is soft, duplicate cancellation is rejected, and delete never removes history", async t => {
  const f = await fixture(t);
  const created = await f.request("/", { method: "POST", body: { ...f.input, shipmentRefs: [] } });
  const id = created.body.data.pickup.id;
  assert.equal((await f.request(`/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await f.request(`/${id}/cancel`, { method: "POST" })).status, 409);
  assert.equal((await f.request(`/${id}`)).body.data.pickup.history.length, 2);
  assert.equal(f.rows.length, 1);
});

test("conditional revisions reject a stale reschedule update instead of overwriting history", async t => {
  const f = await fixture(t);
  const created = await f.request("/", { method: "POST", body: { ...f.input, shipmentRefs: [] } });
  const id = created.body.data.pickup.id;
  f.control.bumpRevisionBeforeNextUpdate = true;
  const outcome = await f.request(`/${id}`, { method: "PATCH", body: { ...f.input, shipmentRefs: [], pickupDate: "2030-05-14" } });
  assert.equal(outcome.status, 409);
  assert.equal(f.rows[0].revision, 1);
  assert.equal(f.rows[0].history.length, 1);
});

test("local pickup status transitions are explicit, owner-scoped and recorded in history", async t => {
  const f = await fixture(t);
  const created = await f.request("/", { method: "POST", body: f.input });
  const id = created.body.data.pickup.id;
  assert.equal((await f.request(`/${id}/status`, { method: "POST", body: { status: "NOT_A_STATUS" } })).status, 409);
  assert.equal((await f.request(`/${id}/status`, { owner: "owner-b", method: "POST", body: { status: "COMPLETED" } })).status, 404);
  const completed = await f.request(`/${id}/status`, { method: "POST", body: { status: "COMPLETED" } });
  assert.equal(completed.body.data.pickup.status, "Completed");
  assert.equal(completed.body.data.pickup.history.at(-1).actor, "owner-a");
  assert.equal(completed.body.data.pickup.history.at(-1).action, "COMPLETED");
  assert.equal((await f.request(`/${id}/status`, { method: "POST", body: { status: "CANCELLED" } })).status, 409);
});

test("local pickup can be scheduled, assigned, failed, rescheduled and collected", async t => {
  const f = await fixture(t);
  const created = await f.request("/", { method: "POST", body: f.input });
  const id = created.body.data.pickup.id;
  assert.ok(created.body.data.pickup.availableStatuses.some(item => item.code === "SCHEDULED"));
  const change = status => f.request(`/${id}/status`, { method: "POST", body: { status } });
  for (const [code, label] of [["SCHEDULED", "Scheduled"], ["ASSIGNED", "Assigned"], ["FAILED", "Failed"]]) {
    assert.equal((await change(code)).body.data.pickup.status, label);
  }
  assert.equal((await change("PICKED_UP")).status, 409);
  const rescheduled = await f.request(`/${id}`, { method: "PATCH", body: { ...f.input, pickupDate: "2030-05-14" } });
  assert.equal(rescheduled.body.data.pickup.status, "Rescheduled");
  const collected = await change("PICKED_UP");
  assert.equal(collected.body.data.pickup.status, "Picked up");
  assert.deepEqual(collected.body.data.pickup.availableStatuses, []);
  assert.equal((await f.request(`/${id}/cancel`, { method: "POST" })).status, 409);
});

test("carrier pickup status requires an adapter and configured provider mapping", async t => {
  let adapterCalls = 0;
  const partnerRegistry = { get: code => code === "MOCK" ? { code: "MOCK", syncPickup: async () => { adapterCalls++; return { status: "mock accepted", responseSnapshot: { ok: true } }; } } : null };
  const f = await fixture(t, { partnerRegistry, statusMappings: { MOCK: { pickup: { "mock accepted": "COMPLETED" } } } });
  f.rows.push({ _id: "333333333333333333333333", owner: "owner-a", workflow: "CARRIER", providerCode: "MOCK", carrierRequestId: "MOCK-REQ", status: "Scheduled", revision: 0, history: [], request: {}, carrierResponse: {} });
  const response = await f.request("/333333333333333333333333/sync", { method: "POST", body: {} });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.pickup.status, "Completed");
  assert.equal(response.body.data.providerStatus, "mock accepted");
  assert.equal(f.rows.at(-1).history.at(-1).action, "STATUS_SYNCED");
  assert.equal(response.body.data.pickup.carrierSyncAvailable, true);
  const repeated = await f.request("/333333333333333333333333/sync", { method: "POST", body: {} });
  assert.equal(repeated.body.data.changed, false);
  assert.equal(f.rows.at(-1).history.length, 1);
  assert.equal(adapterCalls, 2);
});
