const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const ArchivedWebhook = require("../model/delhiveryWebhook");
const { createPartnerRegistry } = require("../services/courierQuotationService");
const { createDelhiveryCourierAdapter } = require("../services/delhiveryCourierAdapter");
const { createTrackingWebhookController, configuredHeaderAuthenticator } = require("../controller/trackingWebhookController");

test("production router keeps the inbound webhook independent of user auth and serves owner-scoped archive rows", async t => {
  const previousSecret = process.env.JWT_SECRET;
  const previousFlag = process.env.DELHIVERY_TRACKING_WEBHOOK_ENABLED;
  process.env.JWT_SECRET = "webhook-tests-only";
  delete process.env.DELHIVERY_TRACKING_WEBHOOK_ENABLED;
  const read = ArchivedWebhook.find;
  const seen = [];
  ArchivedWebhook.find = filter => {
    seen.push(filter);
    const row = { _id: "archive-1", createdAt: new Date("2026-10-10T11:00:00Z"), payload: {
      Shipment: { AWB: "1234567890", ReferenceNo: "TEST-ORDER", Status: { Status: "Manifested", StatusDateTime: "2026-10-10T10:00:00Z" } },
      sensitive: "not for the browser",
    } };
    return { select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => filter.owner === "owner-a" ? [row] : [] };
  };
  const app = express();
  app.use(express.json());
  app.use("/api/delhivery", require("./delhiveryroutes"));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(async () => {
    ArchivedWebhook.find = read;
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
    if (previousFlag === undefined) delete process.env.DELHIVERY_TRACKING_WEBHOOK_ENABLED; else process.env.DELHIVERY_TRACKING_WEBHOOK_ENABLED = previousFlag;
    await new Promise(resolve => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/delhivery/webhook`;
  const headers = owner => ({ Authorization: "Bearer " + jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" }) });
  assert.equal((await fetch(url, { method: "POST" })).status, 503);
  assert.equal((await fetch(url + "/events")).status, 401);
  assert.equal((await fetch(url + "/events?page=0", { headers: headers("owner-a") })).status, 400);
  const result = await (await fetch(url + "/events?waybill=1234567890", { headers: headers("owner-a") })).json();
  assert.equal(result.data.events[0].status, "Manifested");
  assert.equal(Object.hasOwn(result.data.events[0], "payload"), false);
  assert.deepEqual(seen[0], { owner: "owner-a", providerCode: "DELHIVERY", "payload.Shipment.AWB": { $in: ["1234567890", 1234567890] } });
  assert.deepEqual((await (await fetch(url + "/events", { headers: headers("owner-b") })).json()).data.events, []);
});

async function fixture(t, { shipments, enabled = true, useDelhivery = false, authenticateWebhook = async req => req.get("x-mock-signature") === "valid" } = {}) {
  const rows = shipments || [{ _id: "aaaaaaaaaaaaaaaaaaaaaaaa", owner: "owner-a", state: "saved", waybill: "MOCK-AWB", reference: "MOCK-REF", trackingRevision: 0, trackingEvents: [] }];
  const archives = [];
  const Shipment = {
    find(query) { const found = rows.filter(row => row.waybill === query.waybill && row.state === query.state); return { select() { return this; }, lean: async () => structuredClone(found) }; },
    findOne(query) { return { lean: async () => structuredClone(rows.find(row => String(row._id) === String(query._id) && row.owner === query.owner) || null) }; },
    async updateOne(query, update) {
      const row = rows.find(item => String(item._id) === String(query._id) && item.owner === query.owner);
      if (!row || (query.trackingRevision?.$exists === undefined && query.trackingRevision !== undefined && row.trackingRevision !== query.trackingRevision)) return { modifiedCount: 0 };
      Object.assign(row, structuredClone(update.$set)); return { modifiedCount: 1 };
    },
  };
  let adapterCalls = 0;
  const unexpectedCall = () => assert.fail("Inbound webhook must not call the carrier");
  const adapter = useDelhivery ? createDelhiveryCourierAdapter({ get: unexpectedCall, post: unexpectedCall }) :
    { code: "MOCK", quote: async () => ({}), normalizeWebhook: async payload => { adapterCalls += 1; return { waybill: payload.awb, events: [{ providerEventId: payload.eventId, status: payload.status, occurredAt: payload.timestamp, location: payload.location, description: payload.description }] }; } };
  const app = express(); app.use(express.json());
  app.post("/webhook", createTrackingWebhookController({ DelhiveryWebhook: { async updateOne({ archiveKey }, { $setOnInsert }) {
    if (!archives.some(row => row.archiveKey === archiveKey)) archives.push(structuredClone({ archiveKey, ...$setOnInsert }));
  } }, Shipment, partnerRegistry: createPartnerRegistry([adapter]), providerCode: adapter.code, enabled, authenticateWebhook }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = async (body = { awb: "MOCK-AWB", eventId: "evt-1", status: "Delivered", timestamp: "2026-07-01T10:00:00Z", location: "Test City", description: "Delivered" }, signature = "valid") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, { method: "POST", headers: { "Content-Type": "application/json", ...(signature && { "x-mock-signature": signature }) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { send, rows, archives, get adapterCalls() { return adapterCalls; } };
}

test("webhook stays disabled until provider signature rules and secrets are configured", async t => {
  const f = await fixture(t, { enabled: false, authenticateWebhook: null });
  const response = await f.send();
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "WEBHOOK_PROCESSING_DISABLED");
  assert.equal(f.adapterCalls, 0);
  assert.equal(f.archives.length, 0);
  assert.equal(f.rows[0].trackingEvents.length, 0);
});

test("rejects missing or invalid webhook signatures before parsing or persisting", async t => {
  const f = await fixture(t);
  assert.equal((await f.send({}, "invalid")).status, 401);
  assert.equal((await f.send({}, "")).status, 401);
  assert.equal(f.adapterCalls, 0);
  assert.equal(f.archives.length, 0);
});

test("valid signature still requires a valid normalized payload and unambiguous shipment match", async t => {
  const invalid = await fixture(t);
  assert.equal((await invalid.send({ unexpected: true })).status, 400);
  assert.equal(invalid.archives.length, 0);
  const ambiguous = await fixture(t, { shipments: [
    { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", owner: "owner-a", state: "saved", waybill: "MOCK-AWB", trackingRevision: 0, trackingEvents: [] },
    { _id: "bbbbbbbbbbbbbbbbbbbbbbbb", owner: "owner-b", state: "saved", waybill: "MOCK-AWB", trackingRevision: 0, trackingEvents: [] },
  ] });
  const result = await ambiguous.send();
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "AMBIGUOUS_SHIPMENT_MATCH");
  assert.equal(ambiguous.archives.length, 0);
  assert.deepEqual(ambiguous.rows.map(row => row.trackingEvents), [[], []]);
});

test("authorized webhook archives with owner and deduplicates event history", async t => {
  const f = await fixture(t);
  assert.equal((await f.send()).status, 200);
  assert.equal((await f.send()).status, 200);
  assert.equal(f.archives.length, 1);
  assert.equal(f.archives[0].owner, "owner-a");
  assert.equal(f.rows[0].trackingEvents.length, 1);
  assert.equal(f.rows[0].trackingEvents[0].source, "WEBHOOK");
  assert.equal(f.rows[0].trackingStatus, "Delivered");
});

test("Scan Push authentication requires the exact configured authorization header", () => {
  assert.equal(configuredHeaderAuthenticator(undefined), null);
  assert.equal(configuredHeaderAuthenticator("short"), null);
  const header = "Bearer fixture-with-a-long-value-for-testing";
  const authenticate = configuredHeaderAuthenticator(header);
  assert.equal(authenticate({ get: () => undefined }), false);
  assert.equal(authenticate({ get: () => header + "-incorrect" }), false);
  assert.equal(authenticate({ get: name => name === "Authorization" ? header : undefined }), true);
});

test("a Delhivery scan only updates its matching provider booking and archives once", async t => {
  const waybill = "1234567890";
  const shipments = ["MOCK_LOCAL", "DELHIVERY"].map((providerCode, index) => ({
    _id: String(index), owner: "owner-" + index, state: "saved", waybill, reference: "TEST-REFERENCE",
    record: { providerCode }, trackingEvents: [], trackingRevision: 0,
  }));
  const f = await fixture(t, { shipments, useDelhivery: true });
  const payload = { Shipment: { AWB: waybill, ReferenceNo: "UNKNOWN", Status: { Status: "Manifested", StatusDateTime: "2026-07-01T10:00:00Z" } } };
  assert.equal((await f.send(payload)).status, 404);
  payload.Shipment.ReferenceNo = "TEST-REFERENCE";
  assert.equal((await f.send(payload)).status, 200);
  assert.equal((await f.send(payload)).status, 200);
  assert.equal(f.rows[0].trackingEvents.length, 0);
  assert.equal(f.rows[1].trackingEvents.length, 1);
  assert.equal(f.archives.length, 1);
});
