const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createBusinessAuditMiddleware, auditSpec, safeFieldNames, retentionExpiry, auditOutcome, auditIdempotencyKey } = require("./businessAudit");

const specs = [
  ["POST", "/api/customers", "customer.created"],
  ["PATCH", "/api/customers/abc", "customer.updated"],
  ["POST", "/api/rate-cards", "rate_card.created"],
  ["PATCH", "/api/rate-cards/abc", "rate_card.updated"],
  ["POST", "/api/rate-cards/abc/versions", "rate_card.version_created"],
  ["POST", "/api/delhivery/shipments/drafts", "shipment_draft.created"],
  ["PATCH", "/api/delhivery/shipments/drafts/abc", "shipment_draft.updated"],
  ["POST", "/api/delhivery/shipments/drafts/abc/quotes/q1/select", "booking.quote_selected"],
  ["POST", "/api/delhivery/shipments/drafts/abc/book", "booking.attempted"],
  ["POST", "/api/delhivery/shipments/drafts/abc/reconcile", "booking.reconciled"],
  ["POST", "/api/delhivery/pickup-requests", "pickup.created"],
  ["PATCH", "/api/delhivery/pickup-requests/p1", "pickup.updated"],
  ["POST", "/api/delhivery/pickup-requests/p1/cancel", "pickup.cancelled"],
  ["POST", "/api/delhivery/pickup-requests/p1/status", "pickup.lifecycle_changed"],
  ["POST", "/api/delhivery/shipments/s1/tracking/sync", "tracking.synchronized"],
  ["POST", "/api/delhivery/ndr/cases/process", "ndr.observations_processed"],
  ["POST", "/api/delhivery/ndr/cases/n1/actions", "ndr.action_submitted"],
  ["POST", "/api/delhivery/rto/cases/process", "rto.observations_processed"],
  ["POST", "/api/delhivery/rto/cases/r1/return-shipment", "rto.return_shipment_linked"],
  ["POST", "/api/delhivery/rto/cases/r1/sync", "rto.status_synchronized"],
];

test("maps the covered authenticated mutation families and excludes GET requests", () => {
  for (const [method, path, action] of specs) assert.equal(auditSpec({ method, originalUrl: path, params: {} }).action, action);
  assert.equal(auditSpec({ method: "GET", originalUrl: "/api/customers", params: {} }), null);
  assert.equal(auditSpec({ method: "POST", originalUrl: "/api/delhivery/shipments/drafts/abc/book", params: {} }).action, "booking.attempted");
  assert.equal(auditSpec({ method: "POST", originalUrl: "/api/delhivery/shipments/drafts/draft-123/book", params: {} }).entityRef, "draft-123");
});

test("audit middleware records actor, owner, outcome, safe field names and correlation IDs", async t => {
  const events = [];
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.user = { id: "owner-safe" }; req.correlationId = "corr-safe"; next(); });
  app.use(createBusinessAuditMiddleware({ AuditModel: { create: async event => { events.push(event); } } }));
  app.patch("/api/customers/:id", (req, res) => res.json({ success: true, data: { customer: { id: req.params.id } } }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await fetch(`http://127.0.0.1:${server.address().port}/api/customers/customer-1`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "safe name", rateCardId: "card-1", phone: "9000000000", password: "dont-log" }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    ownerId: "owner-safe", actorId: "owner-safe", action: "customer.rate_card_assigned", entityType: "CUSTOMER", entityRef: "customer-1",
    outcome: "SUCCEEDED", statusCode: 200, changedFields: ["displayName", "rateCardId"], correlationId: "corr-safe",
  });
  assert.equal(JSON.stringify(events).includes("dont-log"), false);
  assert.equal(JSON.stringify(events).includes("9000000000"), false);
});

test("business audit failures do not prevent successful responses and unsuccessful non-mutations are omitted", async t => {
  let failures = 0;
  const app = express(); app.use((req, res, next) => { req.user = { id: "owner-a" }; next(); });
  app.use(createBusinessAuditMiddleware({ AuditModel: { create: async () => { throw new Error("contains secret URI"); } }, onError: () => { failures += 1; } }));
  app.post("/api/delhivery/shipments/drafts", (req, res) => res.status(201).json({ success: true, data: { draft: { id: "draft-1" } } }));
  app.patch("/api/customers/:id", (req, res) => res.status(400).json({ success: false }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const created = await fetch(`http://127.0.0.1:${server.address().port}/api/delhivery/shipments/drafts`, { method: "POST" });
  assert.equal(created.status, 201);
  const rejected = await fetch(`http://127.0.0.1:${server.address().port}/api/customers/c1`, { method: "PATCH" });
  assert.equal(rejected.status, 400);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failures, 1);
});

test("business audit retention is opt-in and rejects unsafe or unbounded intervals", () => {
  const now = new Date("2026-11-20T00:00:00.000Z");
  assert.equal(retentionExpiry(undefined, now), undefined);
  assert.equal(retentionExpiry("0", now), undefined);
  assert.equal(retentionExpiry("3651", now), undefined);
  assert.equal(retentionExpiry("30days", now), undefined);
  assert.equal(retentionExpiry("30", now).toISOString(), "2026-12-20T00:00:00.000Z");
});

test("configured business audit retention is stored with the event; missing config preserves history", async t => {
  async function recordWith(days) {
    const events = [];
    const app = express();
    app.use((req, res, next) => { req.user = { id: "owner-a" }; next(); });
    app.use(createBusinessAuditMiddleware({ AuditModel: { create: async event => { events.push(event); } }, getRetentionDays: () => days, now: () => new Date("2026-11-20T00:00:00.000Z") }));
    app.post("/api/customers", (req, res) => res.status(201).json({ success: true }));
    const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    await fetch(`http://127.0.0.1:${server.address().port}/api/customers`, { method: "POST" });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => server.close(resolve));
    return events[0];
  }
  assert.equal((await recordWith(undefined)).expiresAt, undefined);
  assert.equal((await recordWith("45")).expiresAt.toISOString(), "2027-01-04T00:00:00.000Z");
});

test("finance routes use safe owner-scoped audit conventions and record failed operations accurately", () => {
  const cases = [
    ["POST", "/api/billing/walk-in-payments/shipment-1", "payment.walk_in_receipt_created", "SHIPMENT"],
    ["POST", "/api/billing/payments", "payment.allocated", "PAYMENT"],
    ["POST", "/api/billing/invoices", "invoice.generated", "INVOICE"],
    ["POST", "/api/billing/invoices/invoice-1/adjustments", "invoice.adjusted", "INVOICE"],
  ];
  for (const [method, path, action, entityType] of cases) {
    const spec = auditSpec({ method, originalUrl: path, params: {} });
    assert.equal(spec.action, action);
    assert.equal(spec.entityType, entityType);
  }
  assert.equal(auditOutcome(409, { code: "DUPLICATE_PAYMENT" }), "FAILED");
  assert.equal(safeFieldNames({ amount: "10", reference: "x", password: "secret", token: "secret" }, ["amount", "reference", "password", "token"]).sort().join(","), "amount,reference");
  assert.equal(auditIdempotencyKey({ body: { idempotencyKey: "payment-1" }, params: {} }, { action: "payment.allocated" }), "payment-1");
});

test("business audit schema has a partial owner/action/idempotency uniqueness guard", () => {
  const schema = require("../model/businessAuditEvent").schema;
  assert.ok(schema.indexes().some(([keys, options]) => keys.ownerId === 1 && keys.action === 1 && keys.idempotencyKey === 1 && keys.outcome === 1 && options.unique && options.partialFilterExpression?.idempotencyKey?.$type === "string" && options.partialFilterExpression.idempotencyKey.$gt === "" && options.name === "uniq_owner_audit_operation_outcome"));
});

test("audit idempotency keys are trimmed and empty values are omitted", () => {
  const spec = { action: "payment.allocated" };
  assert.equal(auditIdempotencyKey({ body: {}, params: {} }, spec), null);
  assert.equal(auditIdempotencyKey({ body: { idempotencyKey: undefined }, params: {} }, spec), null);
  assert.equal(auditIdempotencyKey({ body: { idempotencyKey: null }, params: {} }, spec), null);
  assert.equal(auditIdempotencyKey({ body: { idempotencyKey: "" }, params: {} }, spec), null);
  assert.equal(auditIdempotencyKey({ body: { idempotencyKey: "   \t\r\n" }, params: {} }, spec), null);
  assert.equal(auditIdempotencyKey({ body: { idempotencyKey: "  payment-1  " }, params: {} }, spec), "payment-1");
});

test("audit key derivation preserves finance actions and allows outcome-specific events", () => {
  const spec = { action: "invoice.adjusted" };
  assert.equal(auditIdempotencyKey({ body: { idempotencyKey: "adjust-1" }, params: {} }, spec), "adjust-1");
  assert.notEqual(auditOutcome(409, { code: "INVOICE_BALANCE_CONFLICT" }), auditOutcome(201, {}));
  assert.equal(auditIdempotencyKey({ body: { invoiceNumber: "  INV-1 " }, params: {} }, { action: "invoice.generated" }), "INV-1");
  assert.equal(auditIdempotencyKey({ body: {}, params: { shipmentId: "  shipment-1 " } }, { action: "payment.walk_in_receipt_created" }), "shipment-1");
  assert.equal(auditIdempotencyKey({ body: {}, params: { id: "  invoice-1 " } }, { action: "invoice.adjusted" }), "invoice-1");
});

test("safe change summaries contain only approved field names", () => {
  assert.deepEqual(safeFieldNames({ displayName: "private", phone: "secret", password: "secret", rateCardId: "id", token: "secret" }, ["displayName", "phone", "rateCardId", "password", "token"]), ["displayName", "rateCardId"]);
});

