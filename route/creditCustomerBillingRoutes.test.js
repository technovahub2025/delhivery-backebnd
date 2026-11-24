const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const createRoutes = require("./creditCustomerBillingRoutes");

const OWNER_A = "billing-owner-a";
const OWNER_B = "billing-owner-b";
const CUSTOMER_A = "64b000000000000000000001";
const CUSTOMER_B = "64b000000000000000000002";
const id = value => new mongoose.Types.ObjectId(value);
const clone = value => JSON.parse(JSON.stringify(value));

function pathValue(row, path) { return path.split(".").reduce((value, key) => value?.[key], row); }
function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = pathValue(row, key);
    if (expected && typeof expected === "object" && "$in" in expected) return expected.$in.map(String).includes(String(actual));
    if (expected && typeof expected === "object" && "$ne" in expected) return actual !== expected.$ne;
    if (expected && typeof expected === "object" && "$exists" in expected) return expected.$exists ? actual !== undefined : actual === undefined;
    if (expected && typeof expected === "object" && "$gte" in expected) return new Date(actual) >= expected.$gte && new Date(actual) < expected.$lt;
    return String(actual ?? "") === String(expected ?? "");
  });
}

function query(rows, filter) {
  let selected = rows.filter(row => matches(row, filter));
  const result = {
    session() { return this; }, select() { return this; },
    limit(n) { selected = selected.slice(0, n); return this; },
    sort() { selected = [...selected].sort((a, b) => new Date(b.invoiceDate || b.createdAt || 0) - new Date(a.invoiceDate || a.createdAt || 0)); return this; },
    lean: async () => clone(selected),
  };
  return result;
}

function fixture(t, { config = {}, extraShipments = [] } = {}) {
  const priorSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "billing-route-test-secret";
  const customerRows = [
    { _id: id(CUSTOMER_A), owner: OWNER_A, category: "CREDIT", companyName: "Dummy Account A", displayName: "Dummy Credit A", gstin: "", monthlyBillingConfig: { billingDateField: "record.date", billableStatusField: "status", billableStatuses: ["Delivered"], gstTreatment: "NOT_APPLICABLE", ...config } },
    { _id: id(CUSTOMER_B), owner: OWNER_B, category: "CREDIT", displayName: "Dummy Credit B", monthlyBillingConfig: {} },
    { _id: new mongoose.Types.ObjectId(), owner: OWNER_A, category: "WALK_IN", displayName: "Dummy Walk-in" },
  ];
  const makeShipment = (shipmentId, owner, customerId, amount, overrides = {}) => ({
    _id: id(shipmentId), owner, state: "saved", kind: "forward", reference: `DUMMY-${shipmentId.slice(-4)}`, waybill: `MOCK-${shipmentId.slice(-4)}`,
    createdAt: new Date("2026-09-20T00:00:00Z"), record: {
      date: "2026-09-20", mode: "SURFACE", status: "Delivered", bookingStatus: "AWB_GENERATED",
      customerSnapshot: { id: customerId, category: "CREDIT", displayName: "Booking-time dummy customer" },
      rateCardSnapshot: { id: "old-card-version-1", version: 1 },
      customerSellingPriceSnapshot: { status: "READY", card: { id: "old-card-version-1", version: 1, currency: "INR" }, customerSelling: { SURFACE: { status: "READY", baseRate: amount, surchargeLines: [], gstLines: [], sellingPrice: amount }, EXPRESS: { status: "READY", sellingPrice: amount } } },
      ...overrides,
    },
  });
  const shipmentRows = [
    makeShipment("64c000000000000000000001", OWNER_A, CUSTOMER_A, "125.25"),
    makeShipment("64c000000000000000000002", OWNER_A, CUSTOMER_A, "1.15"),
    makeShipment("64c000000000000000000003", OWNER_B, CUSTOMER_B, "900.00"),
    ...extraShipments,
  ];
  const invoiceRows = [];
  const adjustmentLocks = new Set();
  const counters = { creates: 0, transactionCalls: 0 };
  const Customer = {
    find: filter => query(customerRows, filter),
    findOne: filter => ({ session() { return this; }, lean: async () => clone(customerRows.find(row => matches(row, filter)) || null) }),
  };
  const Shipment = {
    find: filter => query(shipmentRows, filter),
    findOne: filter => ({ lean: async () => clone(shipmentRows.find(row => matches(row, filter)) || null) }),
    async updateOne(filter, update) {
      const row = shipmentRows.find(item => matches(item, filter));
      if (!row) return { modifiedCount: 0 };
      for (const [path, value] of Object.entries(update.$set)) row.record[path.split(".").at(-1)] = value;
      return { modifiedCount: 1 };
    },
  };
  const Invoice = {
    init: async () => {},
    find: filter => query(invoiceRows, filter),
    findOne: filter => ({ session() { return this; }, lean: async () => clone(invoiceRows.find(row => matches(row, filter)) || null) }),
    async updateOne(filter, update) {
      const row = invoiceRows.find(item => matches(item, filter));
      if (!row) return { matchedCount: 0 };
      Object.assign(row, clone(update.$set));
      for (const [path, value] of Object.entries(update.$push || {})) {
        row[path] ||= [];
        row[path].push(clone(value));
      }
      return { matchedCount: 1 };
    },
    findOneAndUpdate(filter, update) {
      const row = invoiceRows.find(item => matches(item, filter));
      const key = `${filter._id}:${update.$push?.adjustments?.idempotencyKey || ""}`;
      const locked = adjustmentLocks.has(key);
      if (row && !locked) adjustmentLocks.add(key);
      return {
        session() { return this; },
        then(resolve, reject) { return Promise.resolve(row && !locked ? (() => { Object.assign(row, clone(update.$set)); for (const [path, value] of Object.entries(update.$push || {})) { row[path] ||= []; row[path].push(clone(value)); } return clone(row); })() : null).then(resolve, reject); },
      };
    },
    async create(documents) {
      const data = clone(documents[0]);
      const repeated = invoiceRows.some(row => row.owner === data.owner && (row.invoiceNumber === data.invoiceNumber || (String(row.customerId) === String(data.customerId) && row.period.key === data.period.key) || row.lineItems.some(old => data.lineItems.some(line => String(old.shipmentId) === String(line.shipmentId)))));
      if (repeated) throw Object.assign(new Error("unique key"), { code: 11000 });
      counters.creates += 1;
      const saved = { ...data, _id: id(`64d${String(invoiceRows.length + 1).padStart(21, "0")}`), createdAt: new Date("2026-10-01T00:00:00Z") };
      invoiceRows.push(saved);
      return [clone(saved)];
    },
  };
  const Payment = {
    rows: [], init: async () => {},
    find: filter => query(Payment.rows, filter),
    findOne: filter => ({ session() { return this; }, lean: async () => clone(Payment.rows.find(row => matches(row, filter)) || null) }),
    async create(documents) {
      const data = clone(documents[0]);
      if (Payment.rows.some(row => row.owner === data.owner && row.idempotencyKey === data.idempotencyKey)) throw Object.assign(new Error("duplicate idempotency"), { code: 11000 });
      const saved = { ...data, _id: new mongoose.Types.ObjectId(), createdAt: new Date("2026-10-02T00:00:00Z") };
      Payment.rows.push(saved);
      return [clone(saved)];
    },
  };
  Customer.updateOne = async (filter, update) => {
    const row = customerRows.find(item => matches(item, filter));
    if (!row) return { matchedCount: 0 };
    Object.assign(row, update.$set);
    return { matchedCount: 1 };
  };
  const mongooseInstance = {
    isValidObjectId: mongoose.isValidObjectId,
    async startSession() { return { async withTransaction(callback) { counters.transactionCalls += 1; return callback(); }, async endSession() {} }; },
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.correlationId = req.get("X-Request-ID") || null; next(); });
  app.use("/api/billing", createRoutes({ Customer, Shipment, Invoice, Payment, mongooseInstance }));
  const serverPromise = new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  const result = { customerRows, shipmentRows, invoiceRows, paymentRows: Payment.rows, counters, serverPromise };
  t.after(async () => {
    const server = await serverPromise;
    await new Promise(resolve => server.close(resolve));
    if (priorSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = priorSecret;
  });
  result.request = async (path, { owner = OWNER_A, method = "GET", body, token = true, correlationId } = {}) => {
    const server = await serverPromise;
    const bearer = token ? jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" }) : null;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/billing${path}`, { method, headers: { "Content-Type": "application/json", ...(bearer && { Authorization: `Bearer ${bearer}` }), ...(correlationId && { "X-Request-ID": correlationId }) }, ...(body && { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return result;
}

test("billing routes require authentication and owner-scope credit customers and invoices", async t => {
  const f = fixture(t);
  assert.equal((await f.request("/credit-customers", { token: false })).status, 401);
  const customers = await f.request("/credit-customers");
  assert.equal(customers.status, 200);
  assert.deepEqual(customers.body.data.customers.map(row => row.displayName), ["Dummy Credit A"]);
  const otherCustomer = await f.request(`/eligible-shipments?customerId=${CUSTOMER_B}&period=2026-09`);
  assert.equal(otherCustomer.status, 404);
  const otherInvoice = await f.request("/invoices/64d000000000000000000001");
  assert.equal(otherInvoice.status, 404);
  assert.equal(f.counters.creates, 0);
});

test("configured manual walk-in receipts use the saved price and are owner-scoped and replay-safe", async t => {
  const original = process.env.WALK_IN_RECEIPT_METHODS;
  delete process.env.WALK_IN_RECEIPT_METHODS;
  t.after(() => { if (original === undefined) delete process.env.WALK_IN_RECEIPT_METHODS; else process.env.WALK_IN_RECEIPT_METHODS = original; });
  const f = fixture(t);
  const row = f.shipmentRows[0];
  row.record.customerSnapshot.category = "WALK_IN";
  row.record.customerSellingPriceSnapshot.customerSelling.SURFACE.currency = "INR";
  const path = "/walk-in-payments/" + row._id;
  const record = (body, owner) => f.request(path, { method: "POST", body, owner });
  const body = { source: "MANUAL", method: "CASH", reference: "Test receipt", amount: "1.00" };
  assert.equal((await record(body)).body.code, "WALK_IN_RECEIPT_UNAVAILABLE");
  process.env.WALK_IN_RECEIPT_METHODS = "CASH";
  assert.equal((await record(body, OWNER_B)).status, 404);
  assert.equal((await record({ ...body, reference: "" })).status, 400);
  const saved = await record(body);
  assert.equal(saved.status, 201);
  assert.equal(saved.body.data.receipt.amount, "125.25");
  assert.equal(saved.body.data.receipt.source, "MANUAL_RECEIPT");
  assert.equal((await record({ ...body, reference: "Changed" })).body.data.receipt.reference, "Test receipt");
  assert.equal((await f.request("/walk-in-payments")).body.data.manual.shipments[0].receipt.reference, "Test receipt");
});

test("eligibility uses configured booked shipment fields and immutable booking pricing without GET writes", async t => {
  const f = fixture(t);
  const result = await f.request(`/eligible-shipments?customerId=${CUSTOMER_A}&period=2026-09`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.eligibleShipments.map(row => row.amount), ["125.25", "1.15"]);
  assert.deepEqual(result.body.data.blockers, []);
  assert.equal(f.invoiceRows.length, 0);
  assert.equal(f.counters.creates, 0);
});

test("configured cycle statements include nonbillable rows without making them invoiceable", async t => {
  const outside = { owner: OWNER_A, state: "saved", kind: "forward", reference: "OUTSIDE", waybill: "MOCK-OUTSIDE", record: { date: "2026-09-01", status: "Delivered", customerSnapshot: { id: CUSTOMER_A, category: "CREDIT" } } };
  const pending = { ...outside, _id: id("64c000000000000000000098"), reference: "NOT-BILLABLE", record: { ...outside.record, date: "2026-10-09", status: "Pending pickup" } };
  const f = fixture(t, { config: { cycleStartDay: 10 }, extraShipments: [{ ...outside, _id: id("64c000000000000000000099") }, pending] });
  const response = await f.request(`/eligible-shipments?customerId=${CUSTOMER_A}&period=2026-09`);
  assert.equal(response.status, 200);
  const data = response.body.data;
  assert.equal(data.period.start, "2026-09-10T00:00:00.000Z");
  assert.equal(data.period.endExclusive, "2026-10-10T00:00:00.000Z");
  assert.equal(data.eligibleShipments.length, 2);
  assert.equal(data.statement.entries.find(row => row.reference === "NOT-BILLABLE").billingStatus, "NOT_ELIGIBLE");
  assert.ok(!data.statement.entries.some(row => row.reference === "OUTSIDE"));
  assert.equal(f.invoiceRows?.length ?? 0, 0);
});

test("invoice generation is transactional, exact-decimal, audited and snapshots historical rate/pricing data", async t => {
  const f = fixture(t);
  const generated = await f.request("/invoices", { method: "POST", correlationId: "invoice-correlation-1", body: { customerId: CUSTOMER_A, period: "2026-09", invoiceNumber: "DUMMY-INV-2026-09", invoiceDate: "2026-10-01", dueDate: "2026-10-31" } });
  assert.equal(generated.status, 201);
  const invoice = generated.body.data.invoice;
  assert.equal(invoice.totalAmount, "126.4");
  assert.equal(invoice.taxAmount, "0");
  assert.equal(invoice.lineItems.length, 2);
  assert.equal(invoice.lineItems[0].pricingSnapshot.card.version, 1);
  assert.equal(invoice.lineItems[0].rateCardSnapshot.id, "old-card-version-1");
  assert.equal(invoice.auditTrail[0].action, "GENERATED");
  assert.equal(invoice.auditTrail[0].correlationId, "invoice-correlation-1");
  assert.equal(f.counters.transactionCalls, 1);
  const duplicate = await f.request("/invoices", { method: "POST", body: { customerId: CUSTOMER_A, period: "2026-09", invoiceNumber: "DUMMY-INV-OTHER" } });
  assert.equal(duplicate.status, 409);
  assert.equal(f.counters.creates, 1);
});

test("parallel duplicate requests create one invoice and GST snapshot gaps block without writes", async t => {
  const f = fixture(t);
  const body = { customerId: CUSTOMER_A, period: "2026-09", invoiceNumber: "DUMMY-INV-RACE" };
  const [left, right] = await Promise.all([f.request("/invoices", { method: "POST", body }), f.request("/invoices", { method: "POST", body })]);
  assert.deepEqual([left.status, right.status].sort(), [201, 409]);
  assert.equal(f.counters.creates, 1);

  const blocked = fixture(t, { config: { gstTreatment: "SNAPSHOT" } });
  const result = await blocked.request("/invoices", { method: "POST", body: { customerId: CUSTOMER_A, period: "2026-09", invoiceNumber: "DUMMY-INV-GST" } });
  assert.equal(result.status, 422);
  assert.equal(result.body.code, "BILLING_CONFIGURATION_REQUIRED");
  assert.equal(blocked.counters.creates, 0);
});

test("invoice schema declares unique period, invoice number and shipment indexes", () => {
  const model = require("../model/creditCustomerInvoice");
  const indexes = model.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.owner === 1 && keys.customerId === 1 && keys["period.key"] === 1 && options.unique));
  assert.ok(indexes.some(([keys, options]) => keys.owner === 1 && keys.invoiceNumber === 1 && options.unique));
  assert.ok(indexes.some(([keys, options]) => keys.owner === 1 && keys["lineItems.shipmentId"] === 1 && options.unique));
});

test("records partial and full payments with multiple invoice allocations and exact outstanding balances", async t => {
  const f = fixture(t);
  const generated = await f.request("/invoices", { method: "POST", body: { customerId: CUSTOMER_A, period: "2026-09", invoiceNumber: "DUMMY-PAY-INV-1", invoiceDate: "2026-10-01" } });
  const invoice = generated.body.data.invoice;
  const secondInvoice = { ...clone(invoice), _id: id("64e000000000000000000002"), invoiceNumber: "DUMMY-PAY-INV-2", totalAmount: "20.50", paidAmount: "0", outstandingAmount: "20.50", lineItems: [{ ...invoice.lineItems[0], shipmentId: id("64c000000000000000000010") }] };
  f.invoiceRows.push(secondInvoice);
  const firstLine = invoice.lineItems[0];
  const secondLine = invoice.lineItems[1];
  const partial = await f.request("/payments", { method: "POST", correlationId: "payment-correlation-1", body: {
    customerId: CUSTOMER_A, amount: "25.25", currency: "INR", receivedAt: "2026-10-05", idempotencyKey: "dummy-payment-1", reference: "TEST-REF-1",
    allocations: [{ invoiceId: invoice.id, amount: "25.25" }],
  } });
  assert.equal(partial.status, 201);
  assert.equal(f.paymentRows[0].auditTrail[0].correlationId, "payment-correlation-1");
  assert.equal(f.invoiceRows[0].auditTrail.at(-1).correlationId, "payment-correlation-1");
  const statusAfterPartial = await f.request("/payment-invoices?customerId=" + CUSTOMER_A);
  const partialView = statusAfterPartial.body.data.invoices.find(row => row.invoiceNumber === invoice.invoiceNumber);
  assert.equal(partialView.status, "PARTIALLY_PAID");
  assert.equal(partialView.paidAmount, "25.25");
  assert.equal(partialView.outstandingAmount, "101.15");

  const full = await f.request("/payments", { method: "POST", body: {
    customerId: CUSTOMER_A, amount: "121.65", currency: "INR", receivedAt: "2026-10-06", idempotencyKey: "dummy-payment-2",
    allocations: [{ invoiceId: invoice.id, amount: "101.15" }, { invoiceId: secondInvoice._id.toString(), amount: "20.50" }],
  } });
  assert.equal(full.status, 201);
  const invoiceViews = await f.request("/payment-invoices?customerId=" + CUSTOMER_A);
  assert.equal(invoiceViews.body.data.invoices.find(row => row.invoiceNumber === invoice.invoiceNumber).status, "PAID");
  assert.equal(invoiceViews.body.data.invoices.find(row => row.invoiceNumber === secondInvoice.invoiceNumber).status, "PAID");
  const balance = await f.request(`/customers/${CUSTOMER_A}/outstanding`);
  assert.equal(balance.body.data.totalOutstanding, "0");
  assert.equal(f.customerRows[0].outstandingBalanceExact, "0");
  assert.equal(f.paymentRows[1].allocations.length, 2);
  assert.equal(firstLine.pricingSnapshot.card.version, 1);
  assert.equal(secondLine.pricingSnapshot.card.version, 1);
});

test("rejects over-allocation, duplicate invoice allocations, duplicate idempotency and cross-owner invoice access", async t => {
  const f = fixture(t);
  const generated = await f.request("/invoices", { method: "POST", body: { customerId: CUSTOMER_A, period: "2026-09", invoiceNumber: "DUMMY-PAY-GUARD", invoiceDate: "2026-10-01" } });
  const invoiceId = generated.body.data.invoice.id;
  const base = { customerId: CUSTOMER_A, amount: "130", currency: "INR", receivedAt: "2026-10-05", idempotencyKey: "dummy-payment-guard", allocations: [{ invoiceId, amount: "130" }] };
  const over = await f.request("/payments", { method: "POST", body: base });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, "OVER_ALLOCATION");
  assert.equal(f.paymentRows.length, 0);
  const duplicateAlloc = await f.request("/payments", { method: "POST", body: { ...base, amount: "2", allocations: [{ invoiceId, amount: "1" }, { invoiceId, amount: "1" }] } });
  assert.equal(duplicateAlloc.status, 400);

  const accepted = await f.request("/payments", { method: "POST", body: { ...base, amount: "1", allocations: [{ invoiceId, amount: "1" }] } });
  assert.equal(accepted.status, 201);
  const replay = await f.request("/payments", { method: "POST", body: { ...base, amount: "1", allocations: [{ invoiceId, amount: "1" }] } });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, "DUPLICATE_PAYMENT");
  const foreign = await f.request("/payments", { owner: OWNER_B, method: "POST", body: { ...base, customerId: CUSTOMER_B, amount: "1", idempotencyKey: "foreign-payment", allocations: [{ invoiceId, amount: "1" }] } });
  assert.equal(foreign.status, 404);
  assert.equal((await f.request("/payments/64f000000000000000000001", { owner: OWNER_B })).status, 404);
  assert.equal(f.paymentRows.length, 1);
  const forgedIdentity = { ...base, owner: OWNER_A, actor: OWNER_A, amount: "1", idempotencyKey: "identity-guard", allocations: [{ invoiceId, amount: "1" }] };
  assert.equal((await f.request("/payments", { owner: OWNER_B, method: "POST", body: forgedIdentity })).status, 404);
  assert.equal(f.paymentRows.length, 1);
  assert.equal((await f.request("/payments", { method: "POST", body: { ...forgedIdentity, actor: OWNER_B } })).status, 201);
  assert.equal(f.paymentRows[1].owner, OWNER_A);
  assert.equal(f.paymentRows[1].auditTrail[0].actor, OWNER_A);
});

test("payment model declares immutable owner idempotency and allocation indexes", () => {
  const model = require("../model/customerPayment");
  assert.equal(model.schema.options.immutable, true);
  assert.ok(model.schema.indexes().some(([keys, options]) => keys.owner === 1 && keys.idempotencyKey === 1 && options.unique));
  assert.ok(model.schema.indexes().some(([keys]) => keys.owner === 1 && keys["allocations.invoiceId"] === 1));
});

test("records debit and credit adjustments with validation, ownership, idempotency and balance history", async t => {
  const f = fixture(t);
  const generated = await f.request("/invoices", { method: "POST", body: { customerId: CUSTOMER_A, period: "2026-09", invoiceNumber: "DUMMY-ADJ-1", invoiceDate: "2026-10-01" } });
  const invoiceId = generated.body.data.invoice.id;

  const debit = await f.request(`/invoices/${invoiceId}/adjustments`, { method: "POST", body: { kind: "DEBIT", amount: "10.50", reason: "Approved debit", idempotencyKey: "adjust-debit-1" } });
  assert.equal(debit.status, 201);
  assert.equal(debit.body.data.invoice.adjustedTotalAmount, "136.9");
  assert.equal(debit.body.data.invoice.outstandingAmount, "136.9");
  assert.equal(debit.body.data.invoice.adjustments.at(-1).kind, "DEBIT");

  const credit = await f.request(`/invoices/${invoiceId}/adjustments`, { method: "POST", body: { kind: "CREDIT", amount: "6.90", reason: "Approved credit", idempotencyKey: "adjust-credit-1" } });
  assert.equal(credit.status, 201);
  assert.equal(credit.body.data.invoice.adjustedTotalAmount, "130");
  assert.equal(credit.body.data.invoice.outstandingAmount, "130");
  assert.equal(credit.body.data.invoice.adjustments.length, 2);

  const replay = await f.request(`/invoices/${invoiceId}/adjustments`, { method: "POST", body: { kind: "CREDIT", amount: "6.90", reason: "Replay", idempotencyKey: "adjust-credit-1" } });
  assert.equal(replay.status, 409);
  assert.equal(f.invoiceRows[0].adjustments.length, 2);
});

test("rejects invalid, excessive and cross-owner adjustments without changing balances", async t => {
  const f = fixture(t);
  const generated = await f.request("/invoices", { method: "POST", body: { customerId: CUSTOMER_A, period: "2026-09", invoiceNumber: "DUMMY-ADJ-2", invoiceDate: "2026-10-01" } });
  const invoiceId = generated.body.data.invoice.id;
  const before = clone(f.invoiceRows[0]);
  const invalid = [
    {},
    { kind: "DEBIT", amount: "0", reason: "x", idempotencyKey: "adjust-invalid-1" },
    { kind: "OTHER", amount: "1", reason: "x", idempotencyKey: "adjust-invalid-2" },
    { kind: "DEBIT", amount: "1", reason: "", idempotencyKey: "adjust-invalid-3" },
  ];
  for (const body of invalid) assert.equal((await f.request(`/invoices/${invoiceId}/adjustments`, { method: "POST", body })).status, 400);
  const excessive = await f.request(`/invoices/${invoiceId}/adjustments`, { method: "POST", body: { kind: "CREDIT", amount: "999", reason: "Too large", idempotencyKey: "adjust-excessive" } });
  assert.equal(excessive.status, 409);
  assert.deepEqual(f.invoiceRows[0].adjustments || [], before.adjustments || []);
  assert.equal(f.invoiceRows[0].outstandingAmount, before.outstandingAmount);
  const foreign = await f.request(`/invoices/${invoiceId}/adjustments`, { owner: OWNER_B, method: "POST", body: { kind: "DEBIT", amount: "1", reason: "Foreign", idempotencyKey: "adjust-foreign" } });
  assert.equal(foreign.status, 404);
  assert.deepEqual(f.invoiceRows[0].adjustments || [], before.adjustments || []);
});

test("atomically rejects concurrent duplicate adjustment requests", async t => {
  const f = fixture(t);
  const generated = await f.request("/invoices", { method: "POST", body: { customerId: CUSTOMER_A, period: "2026-09", invoiceNumber: "DUMMY-ADJ-RACE", invoiceDate: "2026-10-01" } });
  const invoiceId = generated.body.data.invoice.id;
  const body = { kind: "DEBIT", amount: "2", reason: "Concurrent adjustment", idempotencyKey: "adjust-race-1" };
  const [left, right] = await Promise.all([
    f.request(`/invoices/${invoiceId}/adjustments`, { method: "POST", body }),
    f.request(`/invoices/${invoiceId}/adjustments`, { method: "POST", body }),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [201, 409]);
  assert.equal(f.invoiceRows[0].adjustments.length, 1);
});
