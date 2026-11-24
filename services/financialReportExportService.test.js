const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildFinancialExportSheets, generatePdf, generateXlsx } = require("./financialReportExportService");
const { buildCreditBillingSummary } = require("./profitabilityReportService");

test("builds workbook sheets with the report's exact totals, separate selling/cost values and lifecycle states", () => {
  const report = {
    period: { label: "2026-10", from: "2026-10-01T00:00:00.000Z", toExclusive: "2026-11-01T00:00:00.000Z", dateBasis: "SHIPMENT_DATE" },
    filters: { customerId: "cust-test", partnerCode: "MOCK", shipmentStatus: "Delivered" },
    summary: { shipmentCount: 2, confirmedCount: 1, provisionalCount: 1, configurationRequiredCount: 0, unavailableCount: 0, currencies: [{ currency: "INR", customerRevenueExGst: "100.50", estimatedPartnerCost: "48", finalPartnerCost: "50", confirmedGrossProfit: "55.5", provisionalGrossProfit: "140" }] },
    shipments: [
      { shipmentDate: "2026-10-05T00:00:00.000Z", reference: "DUMMY-1", waybill: "MOCK-1", customer: { name: "Test customer" }, courier: { name: "Mock carrier", code: "MOCK" }, customerSellingAmount: "120", customerSellingCurrency: "INR", customerRevenueExGst: "100.50", customerRevenueCurrency: "INR", estimatedPartnerCost: "48", estimatedPartnerCostCurrency: "INR", finalPartnerCost: "50", finalPartnerCostCurrency: "INR", grossProfit: "55.5", grossProfitCurrency: "INR", profitStatus: "CONFIRMED" },
      { reference: "DUMMY-2", customer: { name: "Test customer" }, courier: { name: "Mock carrier", code: "MOCK" }, customerSellingAmount: null, customerRevenueExGst: null, estimatedPartnerCost: "60", finalPartnerCost: null, profitStatus: "CONFIGURATION_REQUIRED", profitReason: "GST basis is not configured." },
    ],
    customers: [{ key: "Test customer", shipmentCount: 2, confirmedCount: 1, provisionalCount: 0, configurationRequiredCount: 1, unavailableCount: 0, currencies: [{ currency: "INR", customerSellingAmount: "120", customerRevenueExGst: "100.50" }] }],
    couriers: [{ key: "MOCK", shipmentCount: 2, confirmedCount: 1, provisionalCount: 1, configurationRequiredCount: 0, unavailableCount: 0, currencies: [{ currency: "INR", estimatedPartnerCost: "108", finalPartnerCost: "50" }] }],
    creditBillingSummary: { status: "READY", reason: "Current invoice snapshots.", excludedInvoiceCount: 0, invoices: [{ invoiceNumber: "DUMMY-INV", customer: "Test customer", customerId: "cust-1", period: "2026-10", invoiceDate: "2026-10-31T00:00:00.000Z", currency: "INR", totalAmount: "120", paidAmount: "40", outstandingAmount: "80", status: "PARTIALLY_PAID", financialStatus: "READY" }], byPeriodCurrency: [{ period: "2026-10", currency: "INR", invoiceCount: 1, totalAmount: "120", paidAmount: "40", outstandingAmount: "80", status: "READY" }] },
    notes: ["Estimated costs remain provisional."],
  };
  const sheets = buildFinancialExportSheets(report);
  const shipmentXml = generateXlsx(report).toString("utf8");
  assert.deepEqual(sheets.map(sheet => sheet.name), ["Summary", "Shipments", "Customers", "Courier costs", "Estimate vs final", "Credit billing"]);
  assert.match(shipmentXml, /55\.5/);
  assert.match(shipmentXml, /100\.50/);
  assert.match(shipmentXml, /CONFIGURATION_REQUIRED/);
  assert.match(shipmentXml, /UNAVAILABLE/);
  assert.match(shipmentXml, /DUMMY-1/);
  assert.match(shipmentXml, /Credit customer outstanding/);
  assert.match(shipmentXml, /PARTIALLY_PAID/);
  assert.match(shipmentXml, /Monthly billing summary/);
  assert.doesNotMatch(shipmentXml, /grossProfit.*\+.*partnerCost/i);
});

test("creates a valid PDF and empty exports retain explicit unavailable states", () => {
  const pdf = generatePdf({ period: { label: "empty", dateBasis: "SHIPMENT_DATE" }, summary: { shipmentCount: 0, confirmedCount: 0, provisionalCount: 0, configurationRequiredCount: 0, unavailableCount: 0, currencies: [] }, shipments: [], customers: [], couriers: [] });
  assert.ok(pdf.toString("ascii").startsWith("%PDF-1.4"));
  assert.ok(pdf.toString("ascii").endsWith("%%EOF"));
  const xlsx = generateXlsx({ period: { label: "empty" }, summary: { shipmentCount: 0, currencies: [] }, shipments: [], customers: [], couriers: [] });
  assert.equal(xlsx.readUInt32LE(0), 0x04034b50);
  assert.match(xlsx.toString("utf8"), /Unavailable/);
});

test("billing summary uses exact stored invoice balances and does not apportion partial invoices", () => {
  const complete = { invoiceNumber: "DUMMY-INV", customerSnapshot: { displayName: "Test customer" }, customerId: "cust-1", period: { key: "2026-10" }, currency: "INR", totalAmount: "120.50", paidAmount: "20.25", outstandingAmount: null, status: "PARTIALLY_PAID", lineItems: [{ shipmentId: "s1" }] };
  const result = buildCreditBillingSummary([complete], [{ shipmentId: "s1" }]);
  assert.equal(result.status, "READY");
  assert.equal(result.invoices[0].outstandingAmount, "100.25");
  assert.equal(result.byPeriodCurrency[0].outstandingAmount, "100.25");

  const partial = buildCreditBillingSummary([{ ...complete, lineItems: [{ shipmentId: "s1" }, { shipmentId: "outside-filter" }] }], [{ shipmentId: "s1" }]);
  assert.equal(partial.status, "CONFIGURATION_REQUIRED");
  assert.equal(partial.excludedInvoiceCount, 1);
  assert.equal(partial.invoices.length, 0);
  assert.match(partial.reason, /not apportioned/);
});
