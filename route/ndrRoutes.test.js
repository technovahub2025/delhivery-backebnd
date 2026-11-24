const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { createPartnerRegistry } = require("../services/courierQuotationService");
const { validateMappings } = require("../services/providerStatusMappings");
const createNdrRouter = require("../services/ndrRouter").createNdrRouter;
const dashboardStatusMappings = validateMappings({ MOCK: { shipment: { "In Transit": "IN_TRANSIT" } } });

async function fixture(t, adapters = []) {
  const previous = process.env.JWT_SECRET; process.env.JWT_SECRET = "ndr-tests-only";
  const shipments = [
    { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", owner: "owner-a", state: "saved", kind: "forward", waybill: "MOCK-AWB-A", reference: "MOCK-REF-A", record: { partnerCode: "MOCK", customer: "Dummy A", destination: "Test City", payment: "COD" }, trackingEvents: [
      { eventKey: "ndr-a", providerCode: "MOCK", status: "Undelivered", location: "Test Hub", description: "Consignee unavailable", occurredAt: new Date("2026-08-10T10:00:00Z") },
      { eventKey: "delivered-a", providerCode: "MOCK", status: "Delivered", description: "Complete", occurredAt: new Date("2026-08-11T10:00:00Z") },
    ] },
    { _id: "bbbbbbbbbbbbbbbbbbbbbbbb", owner: "owner-b", state: "saved", kind: "forward", waybill: "MOCK-AWB-B", reference: "MOCK-REF-B", record: { partnerCode: "MOCK" }, trackingEvents: [{ eventKey: "ndr-b", providerCode: "MOCK", status: "Delivery attempted", occurredAt: new Date("2026-08-10T10:00:00Z") }] },
  ];
  const cases = [];
  let nextId = 1;
  const getPath = (row, path) => path.split(".").reduce((value, key) => value?.[key], row);
  const matchValue = (actual, expected) => {
    if (expected && typeof expected === "object" && "$exists" in expected) return expected.$exists ? actual !== undefined : actual === undefined;
    if (expected && typeof expected === "object" && "$nin" in expected) return !expected.$nin.includes(actual);
    return String(actual ?? "") === String(expected ?? "");
  };
  const matches = (row, query) => Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some(clause => matches(row, clause));
    if (key === "actions.providerRequestId") return row.actions?.some(action => action.providerRequestId === expected);
    return matchValue(getPath(row, key), expected);
  });
  const clone = value => structuredClone(value);
  const Shipment = {
    find(query) {
      let rows = shipments.filter(row => matches(row, query));
      const chain = { select() { return this; }, lean: async () => rows.map(clone) };
      return chain;
    },
    findOne(query) { return { lean: async () => clone(shipments.find(row => matches(row, query)) || null) }; },
  };
  const NdrCase = {
    find(query) {
      let rows = cases.filter(row => matches(row, query));
      const chain = { sort() { rows = [...rows].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt)); return this; }, lean: async () => rows.map(clone) };
      return chain;
    },
    findOne(query) { return { lean: async () => clone(cases.find(row => matches(row, query)) || null) }; },
    async create(data) {
      if (cases.some(row => row.owner === data.owner && row.shipment === data.shipment && row.trackingEventKey === data.trackingEventKey)) { const error = new Error("duplicate"); error.code = 11000; throw error; }
      const row = { _id: String(nextId++).padStart(24, "0"), revision: 0, actions: [], createdAt: new Date(), updatedAt: new Date(), ...clone(data) };
      cases.push(row); return clone(row);
    },
    findOneAndUpdate(query, update) {
      const row = cases.find(item => matches(item, query));
      return { lean: async () => {
        if (!row) return null;
        Object.assign(row, clone(update.$set));
        return clone(row);
      } };
    },
  };
  const app = express(); app.use(express.json()); app.use(createNdrRouter({ NdrCase, Shipment, partnerRegistry: createPartnerRegistry(adapters), statusMappings: dashboardStatusMappings }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  const request = async (path, { owner = "owner-a", method = "GET", body } = {}) => {
    const token = owner && jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { request, cases, shipments };
}

const processNdr = (f, owner = "owner-a") => f.request("/ndr/cases/process", { owner, method: "POST", body: {} });

test("GET is read-only; explicit owner-scoped processing persists NDR cases with carrier reason details", async t => {
  const f = await fixture(t);
  const result = await f.request("/ndr/cases");
  assert.equal(result.status, 200);
  assert.equal(result.body.data.cases.length, 0);
  assert.equal(f.cases.length, 0);
  const processed = await processNdr(f);
  assert.equal(processed.body.data.createdCases, 1);
  const cases = await f.request("/ndr/cases");
  assert.equal(cases.body.data.cases.length, 1);
  assert.equal(cases.body.data.cases[0].waybill, "MOCK-AWB-A");
  assert.match(cases.body.data.cases[0].reason, /Consignee unavailable/);
  assert.equal(cases.body.data.cases[0].customer, "Dummy A");
  assert.equal(f.cases.length, 1);
  assert.equal((await processNdr(f, "owner-b")).body.data.createdCases, 1);
  assert.equal((await f.request("/ndr/cases", { owner: "owner-b" })).body.data.cases[0].waybill, "MOCK-AWB-B");
  assert.equal(f.cases.length, 2);
});

test("NDR status is owner scoped, never exposes a carrier batch and leaves an unverified action submitted", async t => {
  let reads = 0;
  const adapter = {
    code: "MOCK", quote: async () => ({}),
    ndrAction: async () => ({ submitted: true, providerRequestId: "UPL-TEST" }),
    ndrStatus: async () => { reads++; return { responseSnapshot: { deliveries: ["another account's AWB"] } }; },
  };
  const f = await fixture(t, [adapter]);
  await processNdr(f);
  const row = f.cases[0];
  assert.equal((await f.request(`/ndr/cases/${row._id}/actions`, { method: "POST", body: { action: "RE-ATTEMPT" } })).status, 200);
  assert.equal((await f.request("/ndr/status/UPL-TEST", { owner: "owner-b" })).status, 404);
  const checked = await f.request("/ndr/status/UPL-TEST");
  assert.deepEqual(checked.body.data, { providerRequestId: "UPL-TEST", waybill: "MOCK-AWB-A", status: "UNCONFIRMED" });
  assert.equal(reads, 1);
  assert.equal(row.status, "ACTION_SUBMITTED");
});

test("dashboard NDR shipment GET groups multiple cases and derived events without writes and honors owner/date/status filters", async t => {
  const f = await fixture(t);
  const shipment = f.shipments[0];
  shipment.trackingStatus = "In Transit";
  shipment.trackingEvents.push({ eventKey: "ndr-a-second", providerCode: "MOCK", status: "Delivery attempted", occurredAt: new Date("2026-08-10T11:00:00Z") });
  f.cases.push({ _id: "000000000000000000000001", owner: "owner-a", shipment: shipment._id, trackingEventKey: "ndr-a", waybill: shipment.waybill, reference: shipment.reference, status: "OPEN", occurredAt: new Date("2026-08-10T10:00:00Z"), actions: [] });

  const response = await f.request("/ndr/dashboard-cases?from=2026-08-10&to=2026-08-10&status=inTransit&target=shipments");
  assert.equal(response.status, 200);
  assert.equal(response.body.data.readOnly, true);
  assert.equal(response.body.data.total, 1);
  assert.equal(response.body.data.shipments.length, 1);
  assert.equal(response.body.data.shipments[0].cases.length, 2);
  assert.equal(response.body.data.shipments[0].cases.filter(item => item.persisted).length, 1);
  assert.equal(f.cases.length, 1);

  const wrongStatus = await f.request("/ndr/dashboard-cases?status=delivered&target=shipments");
  assert.equal(wrongStatus.body.data.total, 0);
  const wrongDate = await f.request("/ndr/dashboard-cases?from=2026-08-11&to=2026-08-11&target=shipments");
  assert.equal(wrongDate.body.data.total, 0);
  const otherOwner = await f.request("/ndr/dashboard-cases?target=shipments", { owner: "owner-b" });
  assert.equal(otherOwner.body.data.total, 1);
  assert.equal(otherOwner.body.data.shipments[0].waybill, "MOCK-AWB-B");
  assert.equal((await f.request("/ndr/dashboard-cases?target=active")).status, 400);
});

test("case detail and action routes conceal another owner's case and verify linked shipment ownership", async t => {
  const f = await fixture(t);
  await processNdr(f);
  const caseRow = (await f.request("/ndr/cases")).body.data.cases[0];
  assert.equal((await f.request(`/ndr/cases/${caseRow.id}`, { owner: "owner-b" })).status, 404);
  assert.equal((await f.request(`/ndr/cases/${caseRow.id}/actions`, { owner: "owner-b", method: "POST", body: { action: "CUSTOMER_CONTACT", details: "Called" } })).status, 404);
  assert.equal((await f.request(`/ndr/cases/${caseRow.id}`, { owner: "owner-a" })).body.data.trackingEvents.length, 2);
});

test("records local contact, delivery-instruction and resolution history; validates required details", async t => {
  const f = await fixture(t);
  await processNdr(f);
  const row = (await f.request("/ndr/cases")).body.data.cases[0];
  const path = `/ndr/cases/${row.id}/actions`;
  assert.equal((await f.request(path, { method: "POST", body: { action: "CUSTOMER_CONTACT" } })).status, 400);
  assert.equal((await f.request(path, { method: "POST", body: { action: "CUSTOMER_CONTACT", details: "Spoke to dummy recipient" } })).status, 200);
  assert.equal((await f.request(path, { method: "POST", body: { action: "DELIVERY_INSTRUCTIONS", details: "Call on arrival" } })).status, 200);
  const resolved = await f.request(path, { method: "POST", body: { action: "MARK_RESOLVED", details: "Delivery confirmed by operations" } });
  assert.equal(resolved.body.data.case.status, "RESOLVED");
  assert.equal(resolved.body.data.case.actions.length, 3);
  assert.equal((await f.request(path, { method: "POST", body: { action: "RE-ATTEMPT" } })).status, 409);
});

test("submits supported carrier actions through the injected adapter and blocks duplicate submission", async t => {
  let calls = 0;
  const adapter = { code: "MOCK", quote: async () => ({}), ndrAction: async input => { calls++; assert.equal(input.waybill, "MOCK-AWB-A"); return { submitted: true, providerRequestId: "UPL-MOCK-123", responseSnapshot: { result: "mock-accepted" } }; } };
  const f = await fixture(t, [adapter]);
  await processNdr(f);
  const row = (await f.request("/ndr/cases")).body.data.cases[0];
  const path = `/ndr/cases/${row.id}/actions`;
  const result = await f.request(path, { method: "POST", body: { action: "RE-ATTEMPT" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.case.status, "ACTION_SUBMITTED");
  assert.equal(result.body.data.action.providerRequestId, "UPL-MOCK-123");
  assert.equal((await f.request(path, { method: "POST", body: { action: "RE-ATTEMPT" } })).status, 409);
  assert.equal((await f.request(path, { method: "POST", body: { action: "CUSTOMER_CONTACT", details: "Follow-up call logged" } })).status, 200);
  assert.equal((await f.request(path, { method: "POST", body: { action: "MARK_RESOLVED", details: "Resolved by operations" } })).status, 200);
  assert.equal(calls, 1);
});

test("unsupported carrier action is explicitly unavailable without calling an adapter", async t => {
  const f = await fixture(t);
  await processNdr(f);
  const row = (await f.request("/ndr/cases")).body.data.cases[0];
  const result = await f.request(`/ndr/cases/${row.id}/actions`, { method: "POST", body: { action: "RE-ATTEMPT" } });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "NDR_ACTION_UNAVAILABLE");
  assert.equal(f.cases[0].actions[0].status, "UNAVAILABLE");
});

test("legacy update path validates owner case and invalid action without external requests", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/ndr/update", { method: "POST", body: { waybill: "MOCK-AWB-B", act: "RE-ATTEMPT" } })).status, 404);
  assert.equal((await f.request("/ndr/update", { method: "POST", body: { waybill: "MOCK-AWB-A", act: "DELETE" } })).status, 400);
});

test("adapter action outcomes distinguish definitive rejection from ambiguous response", async t => {
  const rejected = { code: "MOCK", quote: async () => ({}), ndrAction: async () => { const error = new Error("Mock rejection"); error.definitive = true; throw error; } };
  const first = await fixture(t, [rejected]);
  await processNdr(first);
  const rowA = (await first.request("/ndr/cases")).body.data.cases[0];
  const failed = await first.request(`/ndr/cases/${rowA.id}/actions`, { method: "POST", body: { action: "RE-ATTEMPT" } });
  assert.equal(failed.status, 422);
  assert.equal(first.cases[0].status, "ACTION_FAILED");

  const timeout = { code: "MOCK", quote: async () => ({}), ndrAction: async () => { throw new Error("mock timeout"); } };
  const second = await fixture(t, [timeout]);
  await processNdr(second);
  const rowB = (await second.request("/ndr/cases")).body.data.cases[0];
  const ambiguous = await second.request(`/ndr/cases/${rowB.id}/actions`, { method: "POST", body: { action: "RE-ATTEMPT" } });
  assert.equal(ambiguous.status, 502);
  assert.equal(second.cases[0].status, "OUTCOME_UNCONFIRMED");
  assert.equal((await second.request(`/ndr/cases/${rowB.id}/actions`, { method: "POST", body: { action: "RE-ATTEMPT" } })).status, 409);
});
