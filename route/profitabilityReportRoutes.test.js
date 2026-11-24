const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const createRoutes = require("./profitabilityReportRoutes");
const { buildShipmentReport } = require("../services/profitabilityReportService");

const OWNER_A = "profit-owner-a";
const OWNER_B = "profit-owner-b";
const CUSTOMER_A = "64b000000000000000000011";
const CUSTOMER_B = "64b000000000000000000012";
const ID_A = "64c000000000000000000011";
const SECRET = "profitability-test-secret";
const oid = value => new mongoose.Types.ObjectId(value);
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function path(row, value) { return value.split(".").reduce((found, key) => found?.[key], row); }
function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some(clause => matches(row, clause));
    if (key === "$and") return expected.every(clause => matches(row, clause));
    const actual = key === "lineItems.shipmentId" ? (row.lineItems || []).map(line => line.shipmentId) : path(row, key);
    if (expected && typeof expected === "object" && "$in" in expected) {
      if (Array.isArray(actual)) return actual.some(item => expected.$in.map(String).includes(String(item)));
      return expected.$in.map(String).includes(String(actual));
    }
    if (expected && typeof expected === "object" && "$exists" in expected) return (actual !== undefined) === expected.$exists;
    if (expected && typeof expected === "object" && ("$gte" in expected || "$lt" in expected || "$lte" in expected)) {
      return Object.entries(expected).every(([operator, value]) => {
        const left = actual instanceof Date ? actual.getTime() : String(actual ?? "");
        const right = value instanceof Date ? value.getTime() : String(value ?? "");
        if (operator === "$gte") return left >= right;
        if (operator === "$lt") return left < right;
        if (operator === "$lte") return left <= right;
        return false;
      });
    }
    return String(actual ?? "") === String(expected ?? "");
  });
}
function query(rows, filter, onLimit) {
  let selected = rows.filter(row => matches(row, filter));
  const result = { select() { return result; }, sort() { selected = [...selected].reverse(); return result; }, limit(max) { onLimit?.(max); selected = selected.slice(0, max); return result; }, lean: async () => clone(selected) };
  return result;
}

function makeShipment({ id = ID_A, owner = OWNER_A, customerId = CUSTOMER_A, date = "2026-10-05", currency = "INR", status = "Delivered", partnerCode = "MOCK_A", revenue = "100.50", tax = "19.50", finalCost, estimate } = {}) {
  const pricingSnapshot = { status: "TEST", card: { id: "old-rate-card", version: 2, currency }, customerSelling: { SURFACE: { status: "TEST", sellingPrice: "120", taxableAmount: revenue, gstAmount: tax, invoiceAmount: "120" } } };
  const record = { date, status, bookingStatus: "AWB_GENERATED", mode: "SURFACE", customer: "Dummy Test Customer", customerSnapshot: { id: customerId, category: "CREDIT", displayName: "Dummy Customer" }, customerSellingPriceSnapshot: pricingSnapshot, partnerCode, partnerName: `Dummy ${partnerCode}` };
  if (finalCost) record.partnerCostSnapshot = finalCost;
  if (estimate) { record.estimatedPartnerCostSnapshot = estimate; record.partnerQuoteSnapshot = { id: "dummy-quote", partnerTotal: estimate.amount, currency: estimate.currency, ...estimate }; }
  return { _id: oid(id), owner, reference: `DUMMY-${id.slice(-3)}`, waybill: `MOCK-${id.slice(-3)}`, state: "saved", kind: "forward", createdAt: new Date(`${date}T12:00:00.000Z`), record };
}
function makeInvoice(shipment, { treatment = "SNAPSHOT", subtotal = "100.50", tax = "19.50", number = "DUMMY-INV" } = {}) {
  const snapshot = clone(shipment.record.customerSellingPriceSnapshot);
  snapshot.customerSelling.SURFACE.taxableAmount = subtotal;
  snapshot.customerSelling.SURFACE.gstAmount = tax;
  return { _id: oid("64d000000000000000000011"), owner: shipment.owner, invoiceNumber: number, customerId: oid(shipment.record.customerSnapshot.id), customerSnapshot: shipment.record.customerSnapshot, period: { key: "2026-10" }, invoiceDate: new Date("2026-10-31T00:00:00.000Z"), currency: snapshot.card.currency, status: "GENERATED", totalAmount: "120", paidAmount: "0", outstandingAmount: "120", billingConfigurationSnapshot: { gstTreatment: treatment }, lineItems: [{ shipmentId: shipment._id, reference: shipment.reference, mode: "SURFACE", currency: snapshot.card.currency, subtotal, taxAmount: tax, totalAmount: "120", pricingSnapshot: snapshot }] };
}

function fixture(t, { testPerformance = false } = {}) {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  t.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  const complete = makeShipment({ finalCost: { amount: "50", currency: "INR", source: "PROVIDER_INVOICE_OPERATOR_RECORDED", chargeBreakdown: { taxesAndGst: "5" }, taxBasis: { basis: "dummy invoice disclosure" }, gstRecoverability: "5" }, estimate: { amount: "48", currency: "INR" } });
  const estimateOnly = makeShipment({ id: "64c000000000000000000012", date: "2026-10-06", revenue: "200", tax: "0", finalCost: null, estimate: { amount: "60", currency: "INR", chargeBreakdown: { taxesAndGst: "0" }, taxBasis: { basis: "dummy quote tax disclosure" }, gstRecoverability: "0" } });
  const missingTax = makeShipment({ id: "64c000000000000000000013", date: "2026-10-07", revenue: "300", finalCost: { amount: "40", currency: "INR", chargeBreakdown: { taxesAndGst: "8" }, taxBasis: null, gstRecoverability: null }, estimate: { amount: "38", currency: "INR" } });
  const foreign = makeShipment({ id: "64c000000000000000000014", owner: OWNER_B, customerId: CUSTOMER_B, revenue: "999", finalCost: { amount: "1", currency: "INR", chargeBreakdown: { taxesAndGst: "0" }, taxBasis: {}, gstRecoverability: "0" } });
  const outsideRange = makeShipment({ id: "64c000000000000000000015", date: "2026-11-01", revenue: "999", finalCost: { amount: "1", currency: "INR", chargeBreakdown: { taxesAndGst: "0" }, taxBasis: {}, gstRecoverability: "0" } });
  const mismatch = makeShipment({ id: "64c000000000000000000016", currency: "EUR", revenue: "80", finalCost: { amount: "50", currency: "USD", chargeBreakdown: { taxesAndGst: "5" }, taxBasis: { basis: "dummy invoice disclosure" }, gstRecoverability: "5" } });
  const noCost = makeShipment({ id: "64c000000000000000000017", date: "2026-10-08", revenue: "70", finalCost: null, estimate: null });
  const shipments = [complete, estimateOnly, missingTax, foreign, outsideRange, mismatch, noCost];
  if (testPerformance) {
    complete.trackingStatus = "Stored delivery";
    estimateOnly.trackingStatus = "Stored transit";
    missingTax.trackingStatus = "Stored exception";
    mismatch.record.mockOnly = true;
  }
  const invoices = [makeInvoice(complete), makeInvoice(estimateOnly, { subtotal: "200", tax: "0", number: "DUMMY-INV-2" }), makeInvoice(missingTax, { subtotal: "300", tax: "0", number: "DUMMY-INV-3" }), makeInvoice(foreign, { subtotal: "999", tax: "0", number: "PRIVATE-INV" }), makeInvoice(outsideRange, { subtotal: "999", tax: "0", number: "OUTSIDE-INV" }), makeInvoice(mismatch, { subtotal: "80", tax: "0", number: "DUMMY-INV-MISMATCH" }), makeInvoice(noCost, { subtotal: "70", tax: "0", number: "DUMMY-INV-NOCOST" })];
  const counters = { shipmentQueries: 0, invoiceQueries: 0, writes: 0 };
  const write = async () => { counters.writes++; throw new Error("Read-only report attempted a write."); };
  const Shipment = { find(filter) { counters.shipmentQueries++; counters.lastShipmentFilter = filter; return query(shipments, filter, max => { counters.shipmentLimit = max; }); }, updateOne: write, findOneAndUpdate: write, create: write };
  const Invoice = { find(filter) { counters.invoiceQueries++; return query(invoices, filter, max => { counters.invoiceLimit = max; }); }, updateOne: write, findOneAndUpdate: write, create: write };
  const app = express(); app.use(express.json()); app.use("/finance", createRoutes({ Shipment, Invoice }));
  const server = app.listen(0); t.after(() => server.close());
  async function rawRequest(pathname, { owner = OWNER_A, auth = true } = {}) {
    const url = `http://127.0.0.1:${server.address().port}/finance/profitability${pathname}`;
    return fetch(url, { headers: auth ? { Authorization: `Bearer ${jwt.sign({ id: owner }, SECRET, { algorithm: "HS256", expiresIn: "1h" })}` } : {} });
  }
  async function request(pathname, options) {
    const response = await rawRequest(pathname, options);
    return { status: response.status, body: await response.json() };
  }
  return { request, rawRequest, counters };
}

test("courier performance reports stored mapped events and separates samples and unmapped shipments", async t => {
  const prior = process.env.COURIER_STATUS_MAPPINGS_JSON;
  process.env.COURIER_STATUS_MAPPINGS_JSON = JSON.stringify({ MOCK_A: { shipment: {
    "Stored delivery": "DELIVERED", "Stored transit": "IN_TRANSIT", "Stored exception": "EXCEPTION",
  } } });
  t.after(() => { if (prior === undefined) delete process.env.COURIER_STATUS_MAPPINGS_JSON; else process.env.COURIER_STATUS_MAPPINGS_JSON = prior; });
  const f = fixture(t, { testPerformance: true });
  const result = await f.request("?period=2026-10&partnerCode=MOCK_A");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.courierPerformance, [{
    code: "MOCK_A", name: "Dummy MOCK_A", shipmentCount: 5, deliveredCount: 1,
    inTransitCount: 1, exceptionCount: 1, unmappedCount: 1, sampleCount: 1,
  }]);
  assert.equal(f.counters.writes, 0);
});

test("uses booking-time invoice pricing and confirmed final cost for gross profit", async t => {
  const f = fixture(t);
  const result = await f.request("?period=2026-10");
  assert.equal(result.status, 200);
  const report = result.body.data;
  const row = report.shipments.find(item => item.reference === `DUMMY-${ID_A.slice(-3)}`);
  assert.equal(row.customerSellingAmount, "120");
  assert.equal(row.customerRevenueExGst, "100.5");
  assert.equal(row.revenueTaxAmount, "19.5");
  assert.equal(row.finalPartnerCost, "50");
  assert.equal(row.finalPartnerCostExGst, "45");
  assert.equal(row.grossProfit, "55.5");
  assert.equal(row.profitStatus, "CONFIRMED");
  assert.equal(report.summary.currencies.find(item => item.currency === "INR").confirmedGrossProfit, "55.5");
  assert.equal(report.creditBillingSummary.status, "READY");
  assert.equal(report.creditBillingSummary.byPeriodCurrency[0].outstandingAmount, "120");
});

test("historical profitability remains tied to booking and invoice snapshots after the current rate card changes", () => {
  const shipment = makeShipment({ finalCost: { amount: "50", currency: "INR", chargeBreakdown: { taxesAndGst: "5" }, taxBasis: { basis: "test invoice" }, gstRecoverability: "5" } });
  const invoice = makeInvoice(shipment);
  const invoiceLines = new Map([[String(shipment._id), [{ invoice, line: invoice.lineItems[0] }]]]);
  const currentRateCard = { version: 2, surfacePrice: "120", gstRate: "19.5" };
  const before = buildShipmentReport(shipment, invoiceLines);
  currentRateCard.version = 3;
  currentRateCard.surfacePrice = "1";
  currentRateCard.gstRate = "0";
  const after = buildShipmentReport(shipment, invoiceLines);
  assert.deepEqual(
    { revenue: after.customerRevenueExGst, tax: after.revenueTaxAmount, partnerCost: after.finalPartnerCostExGst, profit: after.grossProfit, status: after.profitStatus },
    { revenue: before.customerRevenueExGst, tax: before.revenueTaxAmount, partnerCost: before.finalPartnerCostExGst, profit: before.grossProfit, status: before.profitStatus },
  );
  assert.equal(after.customerRevenueExGst, "100.5");
  assert.equal(after.revenueTaxAmount, "19.5");
  assert.equal(after.finalPartnerCostExGst, "45");
  assert.equal(after.grossProfit, "55.5");
});

test("labels estimate-based profit provisional and never presents an estimate as final", async t => {
  const report = (await fixture(t).request("?period=2026-10")).body.data;
  const row = report.shipments.find(item => item.reference.endsWith("012"));
  assert.equal(row.finalPartnerCost, null);
  assert.equal(row.estimatedPartnerCost, "60");
  assert.equal(row.grossProfit, "140");
  assert.equal(row.profitStatus, "PROVISIONAL");
  assert.match(row.profitReason, /estimated partner quotation/);
  assert.equal(report.summary.provisionalCount, 1);
});

test("blocks profit when partner tax treatment or revenue basis is missing", async t => {
  const report = (await fixture(t).request("?period=2026-10")).body.data;
  const row = report.shipments.find(item => item.reference.endsWith("013"));
  assert.equal(row.finalPartnerCost, "40");
  assert.equal(row.finalPartnerCostExGst, null);
  assert.equal(row.grossProfit, null);
  assert.equal(row.profitStatus, "CONFIGURATION_REQUIRED");
  assert.match(row.profitReason, /tax breakdown|tax basis|recoverable GST/i);
});

test("reports a missing partner cost as unavailable without substituting another value", async t => {
  const report = (await fixture(t).request("?period=2026-10")).body.data;
  const row = report.shipments.find(item => item.reference.endsWith("017"));
  assert.equal(row.customerRevenueExGst, "70");
  assert.equal(row.estimatedPartnerCost, null);
  assert.equal(row.finalPartnerCost, null);
  assert.equal(row.grossProfit, null);
  assert.equal(row.profitStatus, "UNAVAILABLE");
});

test("uses only an explicit booking tax-basis snapshot when a shipment has no invoice", () => {
  const row = makeShipment({ id: "64c000000000000000000018", finalCost: { amount: "50", currency: "INR", chargeBreakdown: { taxesAndGst: "5" }, taxBasis: { basis: "dummy invoice" }, gstRecoverability: "5" } });
  row.record.customerTaxBasisSnapshot = { gstTreatment: "NOT_APPLICABLE" };
  const view = buildShipmentReport(row, new Map());
  assert.equal(view.customerRevenueExGst, "120");
  assert.equal(view.revenueTaxAmount, "0");
  assert.equal(view.revenueSource, "BOOKING_TAX_BASIS_SNAPSHOT");
  assert.equal(view.grossProfit, "75");
  assert.equal(view.profitStatus, "CONFIRMED");
});

test("does not combine currencies and blocks a revenue/cost currency mismatch", async t => {
  const result = await fixture(t).request("?period=2026-10");
  const row = result.body.data.shipments.find(item => item.reference.endsWith("016"));
  assert.equal(row.profitStatus, "CONFIGURATION_REQUIRED");
  assert.equal(row.grossProfit, null);
  assert.deepEqual(result.body.data.summary.currencies.map(item => item.currency), ["EUR", "INR", "USD"]);
  assert.equal(result.body.data.summary.currencies.find(item => item.currency === "INR").finalPartnerCost, "90");
});

test("supports customer, courier, status and inclusive custom date filters with owner isolation", async t => {
  const f = fixture(t);
  assert.equal((await f.request("?from=2026-10-05&to=2026-10-06&customerId=" + CUSTOMER_A + "&partnerCode=MOCK_A&shipmentStatus=Delivered")).body.data.shipments.length, 3);
  const foreign = await f.request("?period=2026-10", { owner: OWNER_B });
  assert.equal(foreign.body.data.shipments.length, 1);
  assert.equal(foreign.body.data.shipments[0].shipmentId, "64c000000000000000000014");
  assert.equal(f.counters.writes, 0);
});

test("requires authentication and validates dates and identifiers", async t => {
  const f = fixture(t);
  assert.equal((await f.request("?period=2026-10", { auth: false })).status, 401);
  assert.equal((await f.request("?period=2026-13")).status, 400);
  assert.equal((await f.request("?from=2026-10-01")).status, 400);
  assert.equal((await f.request("?period=2026-10&customerId=bad")).status, 400);
});

test("exports filtered owner-scoped profitability to Excel with the same report rows and exact totals", async t => {
  const f = fixture(t);
  const queryString = `?from=2026-10-05&to=2026-10-06&customerId=${CUSTOMER_A}&partnerCode=MOCK_A&shipmentStatus=Delivered`;
  const screenReport = await f.request(queryString);
  const response = await f.rawRequest(`/export.xlsx${queryString}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const xml = bytes.toString("utf8");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /spreadsheetml\.sheet/);
  assert.match(response.headers.get("content-disposition"), /\.xlsx/);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.match(xml, /Shipment profitability|Shipments/);
  assert.match(xml, new RegExp(screenReport.body.data.shipments[0].reference));
  assert.match(xml, /55\.5/);
  assert.match(xml, /CONFIRMED/);
  assert.doesNotMatch(xml, /DUMMY-017/);
  assert.equal(f.counters.shipmentLimit, 5001);
  assert.equal(f.counters.invoiceLimit, 5001);
  assert.equal(f.counters.writes, 0);
});

test("exports PDF with unavailable/provisional states, protects owner scope and requires authentication", async t => {
  const f = fixture(t);
  assert.equal((await f.rawRequest("/export.pdf?period=2026-10", { auth: false })).status, 401);
  const response = await f.rawRequest("/export.pdf?period=2026-10", { owner: OWNER_B });
  const bytes = Buffer.from(await response.arrayBuffer());
  const pdf = bytes.toString("ascii");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/pdf/);
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.ok(pdf.endsWith("%%EOF"));
  assert.match(pdf, /DUMMY-014/);
  assert.doesNotMatch(pdf, /DUMMY-011/);
  assert.equal(f.counters.writes, 0);
});

