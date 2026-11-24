const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { createPartnerRegistry } = require("../services/courierQuotationService");
const { validateMappings } = require("../services/providerStatusMappings");
const createRtoRouter = require("../services/rtoRouter").createRtoRouter;

const statusMappings = validateMappings({ MOCK: {
  shipment: { "In Transit": "IN_TRANSIT" },
  rtoTrigger: { "RTO In Transit": "RTO_TRIGGER", "Return to Origin": "RTO_TRIGGER" },
  rto: { "RTO In Transit": "ACTIVE", Delivered: "COMPLETED", "RTO Delivered": "COMPLETED", "Return pickup accepted": "ACTIVE" },
} });

async function fixture(t, adapters = []) {
  const previous = process.env.JWT_SECRET; process.env.JWT_SECRET = "rto-tests-only";
  const shipments = [
    { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", owner: "owner-a", state: "saved", kind: "forward", waybill: "MOCK-ORIGINAL-A", reference: "ORDER-A", record: { partnerCode: "MOCK", customer: "Dummy Customer", destination: "Test City", returnAddress: "1 Test Return Road" }, trackingRevision: 0, trackingEvents: [
      { eventKey: "event-rto-1", providerCode: "MOCK", status: "RTO In Transit", location: "Test Hub", description: "Consignee return initiated", occurredAt: new Date("2026-09-01T10:00:00Z"), source: "SYNC" },
      { eventKey: "event-rto-2", providerCode: "MOCK", status: "Delivered", location: "Return Depot", description: "Received at return depot", occurredAt: new Date("2026-09-03T10:00:00Z"), source: "SYNC" },
      { eventKey: "event-forward", providerCode: "MOCK", status: "Delivered", occurredAt: new Date("2026-08-20T10:00:00Z") },
    ] },
    { _id: "bbbbbbbbbbbbbbbbbbbbbbbb", owner: "owner-b", state: "saved", kind: "forward", waybill: "MOCK-ORIGINAL-B", reference: "ORDER-B", record: { partnerCode: "MOCK" }, trackingRevision: 0, trackingEvents: [{ eventKey: "event-rto-b", providerCode: "MOCK", status: "Return to Origin", occurredAt: new Date("2026-09-02T10:00:00Z") }] },
    { _id: "cccccccccccccccccccccccc", owner: "owner-a", state: "saved", kind: "reverse", waybill: "MOCK-RETURN-A", reference: "RETURN-A", record: { status: "Ready for Pickup" }, trackingRevision: 0, trackingEvents: [{ eventKey: "return-event-1", providerCode: "MOCK", status: "Return pickup accepted", location: "Test Pickup", occurredAt: new Date("2026-09-04T10:00:00Z") }] },
    { _id: "dddddddddddddddddddddddd", owner: "owner-b", state: "saved", kind: "reverse", waybill: "MOCK-RETURN-B", reference: "RETURN-B", record: {}, trackingRevision: 0, trackingEvents: [] },
  ];
  const rtos = [];
  let nextId = 1;
  const getPath = (row, path) => path.split(".").reduce((value, key) => value?.[key], row);
  const match = (row, query) => Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some(item => match(row, item));
    const actual = getPath(row, key);
    if (expected && typeof expected === "object" && "$exists" in expected) return expected.$exists ? actual !== undefined : actual === undefined;
    return String(actual ?? "") === String(expected ?? "");
  });
  const clone = value => structuredClone(value);
  const Shipment = {
    find(query) { const rows = shipments.filter(row => match(row, query)); return { select() { return this; }, lean: async () => rows.map(clone) }; },
    findOne(query) { return { lean: async () => clone(shipments.find(row => match(row, query)) || null) }; },
    async updateOne(query, update) {
      const row = shipments.find(item => match(item, query));
      if (!row) return { modifiedCount: 0 };
      Object.assign(row, clone(update.$set));
      return { modifiedCount: 1 };
    },
  };
  const RtoRecord = {
    find(query) { let rows = rtos.filter(row => match(row, query)); return { sort() { rows = [...rows].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt)); return this; }, lean: async () => rows.map(clone) }; },
    findOne(query) { return { lean: async () => clone(rtos.find(row => match(row, query)) || null) }; },
    async create(data) {
      if (rtos.some(row => row.owner === data.owner && row.originalShipment === data.originalShipment && row.triggerEventKey === data.triggerEventKey)) { const error = new Error("duplicate"); error.code = 11000; throw error; }
      const row = { _id: String(nextId++).padStart(24, "0"), revision: 0, statusHistory: [], createdAt: new Date(), updatedAt: new Date(), ...clone(data) };
      rtos.push(row); return clone(row);
    },
    findOneAndUpdate(query, update) { const row = rtos.find(item => match(item, query)); return { lean: async () => { if (!row) return null; Object.assign(row, clone(update.$set)); return clone(row); } }; },
  };
  const app = express(); app.use(express.json()); app.use(createRtoRouter({ RtoRecord, Shipment, partnerRegistry: createPartnerRegistry(adapters), statusMappings }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  const request = async (path, { owner = "owner-a", method = "GET", body } = {}) => {
    const token = owner && jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { request, rtos, shipments };
}

const processRto = (f, owner = "owner-a") => f.request("/rto/cases/process", { owner, method: "POST", body: {} });

test("GET is read-only; explicit processing materializes mapped RTO history and isolates owners", async t => {
  const f = await fixture(t);
  const first = await f.request("/rto/cases");
  assert.equal(first.status, 200);
  assert.equal(first.body.data.cases.length, 0);
  assert.equal(f.rtos.length, 0);
  assert.equal((await processRto(f)).body.data.createdOrUpdatedCases, 1);
  const records = await f.request("/rto/cases");
  assert.equal(records.body.data.cases.length, 1);
  assert.equal(records.body.data.cases[0].originalWaybill, "MOCK-ORIGINAL-A");
  assert.equal(records.body.data.cases[0].status, "Delivered");
  assert.equal(records.body.data.cases[0].lifecycleState, "COMPLETED");
  assert.equal(records.body.data.cases[0].reason, "Consignee return initiated");
  assert.deepEqual(records.body.data.cases[0].statusHistory.map(item => item.status), ["RTO In Transit", "Delivered"]);
  assert.equal(f.rtos.length, 1);
  await processRto(f, "owner-b");
  const other = await f.request("/rto/cases", { owner: "owner-b" });
  assert.equal(other.body.data.cases.length, 1);
  assert.equal(other.body.data.cases[0].originalWaybill, "MOCK-ORIGINAL-B");
  assert.equal(other.body.data.cases[0].lifecycleState, "UNRESOLVED");
  assert.equal(f.rtos.length, 2);
});

test("dashboard RTO shipment GET groups multiple events read-only and filters by date, shipment status and owner", async t => {
  const f = await fixture(t);
  const shipment = f.shipments[0];
  shipment.trackingStatus = "In Transit";
  shipment.trackingEvents.push({ eventKey: "event-rto-2", providerCode: "MOCK", status: "RTO In Transit", description: "Return update", occurredAt: new Date("2026-09-02T10:00:00Z") });
  f.rtos.push({ _id: "000000000000000000000001", owner: "owner-a", originalShipment: shipment._id, originalWaybill: shipment.waybill, originalReference: shipment.reference, providerCode: "MOCK", triggerEventKey: "event-rto-1", status: "RTO In Transit", lifecycleState: "ACTIVE", occurredAt: new Date("2026-09-01T10:00:00Z"), statusHistory: [] });

  const all = await f.request("/rto/dashboard-cases?target=shipments&status=inTransit&from=2026-09-01&to=2026-09-02");
  assert.equal(all.status, 200);
  assert.equal(all.body.data.readOnly, true);
  assert.equal(all.body.data.total, 1);
  assert.equal(all.body.data.shipments.length, 1);
  assert.equal(all.body.data.shipments[0].cases.length, 2);
  assert.equal(f.rtos.length, 1);

  const singleDate = await f.request("/rto/dashboard-cases?target=shipments&from=2026-09-01&to=2026-09-01");
  assert.equal(singleDate.body.data.total, 1);
  assert.equal(singleDate.body.data.shipments[0].cases.length, 1);
  const otherOwner = await f.request("/rto/dashboard-cases?target=shipments", { owner: "owner-b" });
  assert.equal(otherOwner.body.data.total, 1);
  assert.equal(otherOwner.body.data.shipments[0].originalWaybill, "MOCK-ORIGINAL-B");
  const active = await f.request("/rto/dashboard-cases?target=active");
  assert.equal(active.body.data.cases.length, 1);
  assert.equal(active.body.data.cases[0].lifecycleState, "ACTIVE");
  assert.equal(f.rtos.length, 1);
});

test("detail endpoint validates ownership and returns original and linked return shipment progress", async t => {
  const f = await fixture(t);
  await processRto(f);
  const row = (await f.request("/rto/cases")).body.data.cases[0];
  assert.equal((await f.request(`/rto/cases/${row.id}`, { owner: "owner-b" })).status, 404);
  const linked = await f.request(`/rto/cases/${row.id}/return-shipment`, { method: "POST", body: { waybill: "MOCK-RETURN-A" } });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.data.rto.returnShipment.waybill, "MOCK-RETURN-A");
  assert.equal((await f.request(`/rto/cases/${row.id}/return-shipment`, { method: "POST", body: { waybill: "MOCK-RETURN-B" } })).status, 404);
  const detail = await f.request(`/rto/cases/${row.id}`);
  assert.equal(detail.body.data.originalShipment.customer, "Dummy Customer");
  assert.equal(detail.body.data.returnTrackingEvents.length, 1);
  assert.equal(f.rtos.find(item => String(item._id) === row.id).statusHistory.at(-1).status, "Return pickup accepted");
});

test("rejects duplicate/invalid RTO record IDs and does not infer RTO from unrelated status text", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/rto/cases/not-an-id")).status, 400);
  const { isRtoEvent } = require("../services/rtoService");
  assert.equal(isRtoEvent({ providerCode: "MOCK", status: "Delivered", description: "Return to Origin" }, statusMappings), false);
  assert.equal(isRtoEvent({ providerCode: "MOCK", status: "RTO In Transit" }, statusMappings), true);
  assert.equal(isRtoEvent({ providerCode: "UNKNOWN", status: "RTO In Transit" }, statusMappings), false);
});

test("status sync uses injected adapter, persists events and remains unavailable without one", async t => {
  let calls = 0;
  const adapter = { code: "MOCK", quote: async () => ({}), track: async context => { calls++; assert.equal(context.waybill, "MOCK-ORIGINAL-A"); return { events: [{ providerEventId: "rto-sync-1", status: "RTO Delivered", occurredAt: "2026-09-05T10:00:00Z", location: "Test Return Depot", description: "Returned" }] }; } };
  const f = await fixture(t, [adapter]);
  await processRto(f);
  const row = (await f.request("/rto/cases")).body.data.cases[0];
  const sync = await f.request(`/rto/cases/${row.id}/sync`, { method: "POST", body: {} });
  assert.equal(sync.status, 200);
  assert.equal(calls, 1);
  assert.equal(f.rtos[0].statusHistory.at(-1).providerEventId, "rto-sync-1");

  const disabled = await fixture(t, []);
  await processRto(disabled);
  const disabledRow = (await disabled.request("/rto/cases")).body.data.cases[0];
  const unavailable = await disabled.request(`/rto/cases/${disabledRow.id}/sync`, { method: "POST", body: {} });
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.body.code, "RTO_SYNC_UNAVAILABLE");
});
