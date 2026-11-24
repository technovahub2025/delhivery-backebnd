const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { createPartnerRegistry } = require("../services/courierQuotationService");
const trackingModule = require("../services/shipmentTrackingRouter");
const createTrackingRouter = trackingModule.createShipmentTrackingRouter;

async function fixture(t, adapters = []) {
  const previous = process.env.JWT_SECRET; process.env.JWT_SECRET = "tracking-tests-only";
  const rows = [
    { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", owner: "owner-a", state: "saved", waybill: "MOCK-AWB-A", reference: "MOCK-ORDER-A", record: { partnerCode: "MOCK" }, trackingEvents: [], trackingRevision: 0 },
    { _id: "bbbbbbbbbbbbbbbbbbbbbbbb", owner: "owner-b", state: "saved", waybill: "MOCK-AWB-B", reference: "MOCK-ORDER-B", record: { partnerCode: "MOCK" }, trackingEvents: [], trackingRevision: 0 },
  ];
  const getPath = (row, path) => path.split(".").reduce((value, key) => value?.[key], row);
  const matches = (row, query) => Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some(clause => matches(row, clause));
    const actual = getPath(row, key);
    if (expected && typeof expected === "object" && "$exists" in expected) return expected.$exists ? actual !== undefined : actual === undefined;
    return actual === expected;
  });
  const Shipment = {
    findOne(query) { return { lean: async () => structuredClone(rows.find(row => matches(row, query)) || null) }; },
    async updateOne(query, update) {
      const row = rows.find(item => matches(item, query));
      if (!row) return { modifiedCount: 0 };
      Object.assign(row, structuredClone(update.$set));
      return { modifiedCount: 1 };
    },
  };
  const app = express(); app.use(express.json());
  const trackingRouter = createTrackingRouter({ Shipment, partnerRegistry: createPartnerRegistry(adapters) });
  app.use(trackingRouter);
  app.use("/api/delhivery", trackingRouter);
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  const request = async (path, { owner = "owner-a", method = "GET", body } = {}) => {
    const token = owner && jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { request, rows };
}

test("tracking lookup is authenticated and scoped by waybill or reference", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/track?waybill=MOCK-AWB-A", { owner: "owner-b" })).status, 404);
  assert.equal((await f.request("/track?ref_ids=MOCK-ORDER-A")).body.data.shipment.reference, "MOCK-ORDER-A");
  assert.equal((await f.request("/track?waybill=MOCK-AWB-A&ref_ids=MOCK-ORDER-A")).status, 400);
  assert.equal((await f.request("/track?waybill=MOCK-AWB-A", { owner: null })).status, 401);
});

test("frontend tracking URL contract resolves at /api/delhivery/track", async t => {
  const f = await fixture(t);
  const response = await f.request("/api/delhivery/track?waybill=MOCK-AWB-A");
  assert.equal(response.status, 200);
  assert.equal(response.body.data.shipment.waybill, "MOCK-AWB-A");
});

test("history persists validated events, sorts by occurrence, deduplicates provider IDs and retains delayed events", async t => {
  const f = await fixture(t, [{ code: "MOCK", name: "Mock", quote: async () => ({}), track: async () => ({ events: [
    { providerEventId: "late", status: "Delivered", occurredAt: "2026-05-04T10:00:00Z", location: "Test City", description: "Complete" },
    { providerEventId: "early", status: "In transit", occurredAt: "2026-05-03T10:00:00Z", location: "Test Hub", description: "Departed" },
  ] }) }]);
  const sync = () => f.request("/shipments/aaaaaaaaaaaaaaaaaaaaaaaa/tracking/sync", { method: "POST", body: {} });
  assert.equal((await sync()).status, 200);
  assert.equal((await sync()).status, 200);
  const row = f.rows[0];
  assert.equal(row.trackingEvents.length, 2);
  assert.deepEqual(row.trackingEvents.map(event => event.status), ["In transit", "Delivered"]);
  assert.equal(row.trackingStatus, "Delivered");
  assert.equal((await f.request("/shipments/aaaaaaaaaaaaaaaaaaaaaaaa/tracking", { owner: "owner-b" })).status, 404);
  assert.equal((await f.request("/shipments/aaaaaaaaaaaaaaaaaaaaaaaa/tracking")).body.data.events.length, 2);
});

test("invalid adapter events are rejected and cannot alter shipment history", async t => {
  const f = await fixture(t, [{ code: "MOCK", quote: async () => ({}), track: async () => ({ events: [{ status: "", occurredAt: "not-a-date" }] }) }]);
  const response = await f.request("/shipments/aaaaaaaaaaaaaaaaaaaaaaaa/tracking/sync", { method: "POST", body: {} });
  assert.equal(response.status, 502);
  assert.equal(response.body.code, "INVALID_PROVIDER_EVENTS");
  assert.deepEqual(f.rows[0].trackingEvents, []);
});

test("concurrent tracking updates use revision-guarded writes and preserve both events", async t => {
  let eventNumber = 0;
  const f = await fixture(t, [{ code: "MOCK", quote: async () => ({}), track: async () => {
    eventNumber += 1;
    return { events: [{ providerEventId: `event-${eventNumber}`, status: `Scan ${eventNumber}`, occurredAt: `2026-06-01T10:00:0${eventNumber}Z` }] };
  } }]);
  const calls = ["/shipments/aaaaaaaaaaaaaaaaaaaaaaaa/tracking/sync", "/shipments/aaaaaaaaaaaaaaaaaaaaaaaa/tracking/sync"];
  await Promise.all(calls.map(path => f.request(path, { method: "POST", body: {} })));
  assert.equal(f.rows[0].trackingEvents.length, 2);
  assert.equal(f.rows[0].trackingRevision, 2);
});

test("tracking sync stays unavailable when no matching carrier adapter exists", async t => {
  const f = await fixture(t, []);
  const result = await f.request("/shipments/aaaaaaaaaaaaaaaaaaaaaaaa/tracking/sync", { method: "POST", body: {} });
  assert.equal(result.status, 409);
  assert.equal(f.rows[0].trackingRevision, 0);
});

test("Delhivery tracking rejects non-numeric AWBs before any carrier call", async t => {
  let calls = 0;
  const f = await fixture(t, [{ code: "DELHIVERY", quote: async () => ({}), track: async () => { calls += 1; return { events: [] }; } }]);
  f.rows[0].record = { partnerCode: "DELHIVERY" };
  f.rows[0].waybill = "MOCK-AWB-A";
  const result = await f.request("/shipments/aaaaaaaaaaaaaaaaaaaaaaaa/tracking/sync", { method: "POST", body: {} });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "INVALID_TRACKING_AWB");
  assert.equal(calls, 0);
});

test("tracking adapter diagnostics contain only safe capability metadata", async () => {
  const records = [];
  const logger = { info: value => records.push(JSON.parse(value)), warn: value => records.push(JSON.parse(value)) };
  const environment = {
    APP_DEPLOYMENT_MODE: "production",
    DELHIVERY_BASE_URL: "https://carrier.example.test",
    DELHIVERY_API_TOKEN: "do-not-log-this-token",
    DELHIVERY_TRACKING_ENABLED: "false",
  };
  const Shipment = { updateOne: async () => ({ modifiedCount: 0 }) };
  const row = { _id: "shipment-safe-diagnostic", owner: "owner-a", record: { providerCode: "DELHIVERY" }, waybill: "58063010002321" };
  const result = await trackingModule.synchronizeShipmentTracking({
    Shipment, row, partnerRegistry: { get: () => null }, getEnvironment: () => environment, logger,
  }).catch(error => error);
  assert.equal(result.code, "TRACKING_FEATURE_DISABLED");
  assert.ok(records.length >= 2);
  for (const entry of records) {
    assert.deepEqual(Object.keys(entry).sort(), ["delhiveryConfigurationPresent", "event", "hasTrackingAdapter", "resolvedCourierCode", "shipmentId", "trackingFeatureEnabled"].sort());
    assert.equal(JSON.stringify(entry).includes("do-not-log-this-token"), false);
  }
});

test("tracking sync classifies invalid responses with a safe code", async t => {
  const f = await fixture(t, [{ code: "MOCK", quote: async () => ({}), track: async () => { throw Object.assign(new Error("shape"), { code: "INVALID_TRACKING_RESPONSE" }); } }]);
  const result = await f.request("/shipments/aaaaaaaaaaaaaaaaaaaaaaaa/tracking/sync", { method: "POST", body: {} });
  assert.equal(result.status, 502);
  assert.equal(result.body.code, "INVALID_TRACKING_RESPONSE");
  assert.equal(result.body.message, "The courier returned an invalid or mismatched tracking response.");
  assert.equal(result.body.providerStatus, undefined);
});

test("tracking sync classifies provider HTTP, timeout, configuration and unexpected errors", async t => {
  const cases = [
    { error: Object.assign(new Error("bad gateway"), { response: { status: 502 } }), status: 502, code: "COURIER_HTTP_ERROR", providerStatus: 502 },
    { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: 504, code: "COURIER_TIMEOUT" },
    { error: Object.assign(new Error("disabled"), { code: "DELHIVERY_FEATURE_DISABLED" }), status: 503, code: "DELHIVERY_CONFIGURATION_ERROR" },
    { error: new Error("unexpected"), status: 502, code: "TRACKING_SYNC_FAILED" },
  ];
  for (const expected of cases) {
    const f = await fixture(t, [{ code: "MOCK", quote: async () => ({}), track: async () => { throw expected.error; } }]);
    const result = await f.request("/shipments/aaaaaaaaaaaaaaaaaaaaaaaa/tracking/sync", { method: "POST", body: {} });
    assert.equal(result.status, expected.status);
    assert.equal(result.body.code, expected.code);
    if (expected.providerStatus) assert.equal(result.body.providerStatus, expected.providerStatus);
    else assert.equal(result.body.providerStatus, undefined);
  }
});
test("scheduled tracking runs with mock booking enabled and claims a shipment only once", async () => {
  const { createTrackingPoller } = require("../services/trackingPolling");
  const assert = require("node:assert/strict");
  const row = { _id: "test-shipment", owner: "owner-a", state: "saved", waybill: "1234567890", record: { providerCode: "DELHIVERY" } };
  let claims = 0;
  let reads = 0;
  const Shipment = {
    find: () => ({ sort() { return this; }, limit() { return this; }, lean: async () => [row] }),
    updateOne: async filter => { assert.equal(filter.owner, row.owner); return { modifiedCount: ++claims === 1 ? 1 : 0 }; },
  };
  const partnerRegistry = { get: () => ({ code: "DELHIVERY", track: async () => { reads += 1; return { events: [] }; } }) };
  const environment = { MOCK_COURIER_ADAPTER_ENABLED: "true", DELHIVERY_TRACKING_ENABLED: "true", DELHIVERY_TRACKING_POLL_ENABLED: "true", DELHIVERY_TRACKING_POLL_MINUTES: "15" };
  let tick;
  const worker = createTrackingPoller({ Shipment, partnerRegistry, environment, schedule(callback, ms) {
    assert.equal(ms, 15 * 60_000);
    tick = callback;
    return { unref() {} };
  } });
  assert.ok(worker.start());
  assert.equal(await tick(), 1);
  assert.equal(await tick(), 0);
  environment.DELHIVERY_TRACKING_ENABLED = "false";
  assert.equal(await tick(), 0);
  assert.equal(reads, 1);
  assert.equal(claims, 2);
});

test("authorized Delhivery sync preserves real timestamps and leaves stored history intact on an empty reply", async t => {
  let calls = 0;
  const f = await fixture(t, [{ code: "DELHIVERY", quote: async () => ({}), track: async () => ({
    events: ++calls <= 2 ? [{ status: "In Transit", occurredAt: "2026-11-20T14:30:00+05:30" }] : [],
  }) }]);
  const row = f.rows[0];
  row.waybill = "1234567890";
  row.record.partnerCode = "DELHIVERY";
  const path = "/shipments/aaaaaaaaaaaaaaaaaaaaaaaa/tracking/sync";
  assert.equal((await f.request(path, { method: "POST", owner: "owner-b" })).status, 404);
  assert.equal(calls, 0);
  for (let i = 0; i < 2; i++) assert.equal((await f.request(path, { method: "POST" })).status, 200);
  const empty = await f.request(path, { method: "POST" });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data.sync, { outcome: "NO_EVENTS", providerCode: "DELHIVERY" });
  assert.equal(empty.body.data.events.length, 1);
  assert.equal(empty.body.data.events[0].occurredAt, "2026-11-20T09:00:00.000Z");
  row.record.mockOnly = true;
  assert.equal((await f.request(path, { method: "POST" })).status, 409);
  assert.equal(calls, 3);
});

test("scheduled sync failures are correlated without disclosing upstream details", async () => {
  const { createTrackingPoller } = require("../services/trackingPolling");
  const { requestContext } = require("../utils/requestLogging");
  const row = { _id: "test-shipment", owner: "owner-a", state: "saved", waybill: "1234567890", record: { providerCode: "DELHIVERY" } };
  let expectedId;
  const warnings = [];
  const worker = createTrackingPoller({
    Shipment: {
      find: () => ({ sort() { return this; }, limit() { return this; }, lean: async () => [row] }),
      updateOne: async () => ({ modifiedCount: 1 }),
    },
    partnerRegistry: { get: () => ({ code: "DELHIVERY", track: async () => {
      expectedId = requestContext.getStore().correlationId;
      throw Object.assign(new Error("private upstream response"), { response: { status: 401 } });
    } }) },
    environment: { DELHIVERY_TRACKING_ENABLED: "true", DELHIVERY_TRACKING_POLL_ENABLED: "true" },
    logger: { warn: entry => warnings.push(JSON.parse(entry)) },
  });
  assert.equal(await worker.run(), 0);
  assert.match(expectedId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(warnings, [{ event: "tracking.poll", code: "TRACKING_SYNC_FAILED", correlationId: expectedId, providerStatus: 401 }]);
});
