const mongoose = require("mongoose");
const { plainDecimal, addDecimals, subtractDecimals, parsePeriod } = require("./creditCustomerBillingService");
const { loadStatusMappings, mapProviderStatus } = require("./providerStatusMappings");

const PROFIT_STATUSES = new Set(["CONFIRMED", "PROVISIONAL", "CONFIGURATION_REQUIRED", "UNAVAILABLE"]);
const MAX_REPORT_SHIPMENTS = 5000;

class ProfitabilityReportError extends Error {
  constructor(message, { status = 400, code = "PROFITABILITY_INVALID_REQUEST" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function dateRange({ period, from, to } = {}) {
  if (period && (from || to)) throw new ProfitabilityReportError("Use either a month period or a custom date range, not both.");
  if (period) {
    try { return { ...parsePeriod(period), label: period }; }
    catch (error) { throw new ProfitabilityReportError(error.message); }
  }
  if (!from && !to) throw new ProfitabilityReportError("A month period or both from and to dates are required.");
  if (!from || !to) throw new ProfitabilityReportError("Both from and to dates are required for a custom range.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new ProfitabilityReportError("from and to must use YYYY-MM-DD.");
  const start = new Date(`${from}T00:00:00.000Z`);
  const finalDay = new Date(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(finalDay.getTime()) || finalDay < start || start.toISOString().slice(0, 10) !== from || finalDay.toISOString().slice(0, 10) !== to) throw new ProfitabilityReportError("The date range is invalid.");
  return { start, endExclusive: new Date(finalDay.getTime() + 86400000), label: `${from}..${to}` };
}

function snapshotMoney(value) { return plainDecimal(value); }
function asDate(value) {
  if (!value) return null;
  const result = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}
function shipmentDate(row) { return asDate(row.record?.date) || asDate(row.createdAt); }
function idOf(value) { return value == null ? "" : String(value); }
function modePricingOf(snapshot, mode) { return snapshot?.customerSelling?.[String(mode || "").toUpperCase()] || null; }

function customerSellingAmount(row) {
  const record = row.record || {};
  const snapshot = record.customerSellingPriceSnapshot;
  const modePrice = modePricingOf(snapshot, record.mode);
  const amount = snapshotMoney(modePrice?.sellingPrice);
  const currency = String(snapshot?.card?.currency || "").trim().toUpperCase();
  return amount != null && /^[A-Z]{3}$/.test(currency) ? { amount, currency, snapshot, modePrice } : null;
}

function invoiceRevenue(invoiceLines, shipmentId, selling) {
  const matches = invoiceLines.get(shipmentId) || [];
  if (matches.length !== 1) return { amount: null, currency: null, sellingAmount: null, source: null, taxAmount: null, status: matches.length ? "CONFIGURATION_REQUIRED" : "MISSING", reason: matches.length ? "Multiple invoice lines reference this shipment." : "No invoice snapshot is available." };
  const { invoice, line } = matches[0];
  const treatment = invoice.billingConfigurationSnapshot?.gstTreatment;
  const pricing = line.pricingSnapshot;
  const modePrice = modePricingOf(pricing, line.mode);
  const expected = treatment === "NOT_APPLICABLE" ? snapshotMoney(modePrice?.sellingPrice) : treatment === "SNAPSHOT" ? snapshotMoney(modePrice?.taxableAmount) : null;
  const expectedTax = treatment === "NOT_APPLICABLE" ? "0" : snapshotMoney(modePrice?.gstAmount);
  const lineSubtotal = snapshotMoney(line.subtotal);
  const invoiceTax = snapshotMoney(line.taxAmount);
  const currency = String(line.currency || "").trim().toUpperCase();
  const invoiceSelling = snapshotMoney(modePrice?.sellingPrice);
  if (expected == null || expectedTax == null || lineSubtotal == null || invoiceTax == null || expected !== lineSubtotal || expectedTax !== invoiceTax || !/^[A-Z]{3}$/.test(currency) || (selling?.currency && currency !== selling.currency)) {
    return { amount: null, currency: null, source: invoice.invoiceNumber || null, taxAmount: invoiceTax, status: "CONFIGURATION_REQUIRED", reason: "The invoice tax treatment or booking-time pricing snapshot is missing or inconsistent." };
  }
  return { amount: expected, currency, sellingAmount: invoiceSelling, source: invoice.invoiceNumber || null, taxAmount: invoiceTax, chargeBreakdown: structuredClone(modePrice), status: "READY", reason: null };
}

function bookingSnapshotRevenue(row, selling) {
  const record = row.record || {};
  const snapshot = record.customerSellingPriceSnapshot;
  const basis = record.customerTaxBasisSnapshot || snapshot?.taxBasis;
  const modePrice = modePricingOf(snapshot, record.mode);
  const treatment = basis?.gstTreatment;
  const amount = treatment === "NOT_APPLICABLE" ? snapshotMoney(modePrice?.sellingPrice) : treatment === "SNAPSHOT" ? snapshotMoney(modePrice?.taxableAmount) : null;
  const tax = treatment === "NOT_APPLICABLE" ? "0" : treatment === "SNAPSHOT" ? snapshotMoney(modePrice?.gstAmount) : null;
  const currency = String(snapshot?.card?.currency || "").trim().toUpperCase();
  if (amount == null || tax == null || !/^[A-Z]{3}$/.test(currency) || (selling?.currency && currency !== selling.currency)) {
    return { amount: null, currency: null, sellingAmount: selling?.amount ?? null, source: null, taxAmount: null, status: "CONFIGURATION_REQUIRED", reason: "The booking snapshot does not contain an explicit supported customer GST treatment and tax basis." };
  }
  return { amount, currency, sellingAmount: snapshotMoney(modePrice?.sellingPrice), source: "BOOKING_TAX_BASIS_SNAPSHOT", taxAmount: tax, chargeBreakdown: structuredClone(modePrice), status: "READY", reason: null };
}

function partnerAmount(record, final = false) {
  if (final) {
    const snapshot = record.partnerCostSnapshot;
    const amount = snapshotMoney(snapshot?.amount ?? snapshot?.totalAmount ?? snapshot?.total);
    const currency = String(snapshot?.currency || "").trim().toUpperCase();
    if (amount == null || !/^[A-Z]{3}$/.test(currency)) return null;
    return { amount, currency, source: snapshot.source || "FINAL_PARTNER_COST", reference: snapshot.sourceReference || null, chargeBreakdown: snapshot.chargeBreakdown || null, taxBasis: snapshot.taxBasis || null, recoverableGst: snapshotMoney(snapshot.gstRecoverability) };
  }
  const snapshot = record.estimatedPartnerCostSnapshot || {};
  const quote = record.partnerQuoteSnapshot || {};
  const amount = snapshotMoney(snapshot.amount ?? quote.partnerTotal ?? quote.amount);
  const currency = String(snapshot.currency || quote.currency || "").trim().toUpperCase();
  if (amount == null || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amount, currency, source: snapshot.source || "PARTNER_QUOTE", reference: snapshot.quoteId || quote.id || null, chargeBreakdown: snapshot.chargeBreakdown || quote.chargeBreakdown || null, taxBasis: snapshot.taxBasis || quote.taxBasis || null, recoverableGst: snapshotMoney(snapshot.gstRecoverability ?? quote.gstRecoverability) };
}

function partnerCostExGst(cost) {
  if (!cost) return { amount: null, status: "UNAVAILABLE", reason: "No partner cost snapshot is available." };
  const taxAmount = snapshotMoney(cost.chargeBreakdown?.taxesAndGst);
  if (taxAmount == null || cost.recoverableGst == null || !cost.taxBasis || typeof cost.taxBasis !== "object" || Array.isArray(cost.taxBasis) || !Object.keys(cost.taxBasis).length) {
    return { amount: null, status: "CONFIGURATION_REQUIRED", reason: "Partner tax breakdown, tax basis, or recoverable GST amount is not confirmed." };
  }
  const taxAfterRecovery = subtractDecimals(taxAmount, cost.recoverableGst);
  if (taxAfterRecovery == null || taxAfterRecovery.startsWith("-")) return { amount: null, status: "CONFIGURATION_REQUIRED", reason: "Recoverable GST exceeds the captured partner tax amount." };
  const net = subtractDecimals(cost.amount, cost.recoverableGst);
  if (net == null || net.startsWith("-")) return { amount: null, status: "CONFIGURATION_REQUIRED", reason: "The partner cost cannot be reduced by the supplied recoverable GST amount safely." };
  return { amount: net, status: "READY", reason: null };
}

function buildShipmentReport(row, invoiceLines, statusMappings = {}) {
  const record = row.record || {};
  const date = shipmentDate(row);
  const snapshotSelling = customerSellingAmount(row);
  const invoice = invoiceRevenue(invoiceLines, String(row._id), snapshotSelling);
  const revenue = invoice.status === "MISSING" ? bookingSnapshotRevenue(row, snapshotSelling) : invoice;
  const selling = snapshotSelling || (revenue.sellingAmount != null && revenue.currency ? { amount: revenue.sellingAmount, currency: revenue.currency } : null);
  const estimate = partnerAmount(record, false);
  const final = partnerAmount(record, true);
  const estimateNet = partnerCostExGst(estimate);
  const finalNet = partnerCostExGst(final);
  const finalSnapshotPresent = Boolean(record.partnerCostSnapshot);
  const sampleEstimate = estimate?.source === "LOCAL_MOCK_ONLY" || record.mockOnly === true;
  const activeCost = finalSnapshotPresent ? finalNet : estimateNet;
  const activeCostCurrency = finalSnapshotPresent ? final?.currency || null : estimate?.currency || null;
  let profitStatus = "UNAVAILABLE";
  let profit = null;
  let profitReason = null;
  if (!selling || (!estimate && !final)) {
    profitStatus = "UNAVAILABLE";
    profitReason = !selling ? "Historical customer selling price is missing." : "No estimate or final partner cost is available.";
  } else if (sampleEstimate && !finalSnapshotPresent) {
    profitReason = "A sample courier charge is unavailable for financial profitability.";
  } else if (revenue.amount == null || activeCost.amount == null) {
    profitStatus = "CONFIGURATION_REQUIRED";
    profitReason = revenue.amount == null ? revenue.reason : activeCost.reason;
  } else if (revenue.currency !== activeCostCurrency) {
    profitStatus = "CONFIGURATION_REQUIRED";
    profitReason = "Customer revenue and partner cost use different currencies; no conversion rule is configured.";
  } else {
    profit = subtractDecimals(revenue.amount, activeCost.amount);
    profitStatus = final ? "CONFIRMED" : "PROVISIONAL";
    profitReason = finalSnapshotPresent ? null : "Uses an estimated partner quotation; no final partner cost is recorded.";
  }
  const customer = record.customerSnapshot || {};
  const providerCode = String(record.partnerCode || record.carrierCode || record.providerCode || "").toUpperCase();
  const trackingOutcome = record.mockOnly === true || providerCode === "MOCK_LOCAL"
    ? "SAMPLE" : mapProviderStatus(providerCode, "shipment", row.trackingStatus, statusMappings);
  return {
    shipmentId: String(row._id), reference: row.reference || record.reference || "", waybill: row.waybill || record.waybill || null,
    shipmentDate: date?.toISOString() || null, shipmentStatus: record.status || record.bookingStatus || null, bookingStatus: record.bookingStatus || null,
    mode: String(record.mode || "").toUpperCase() || null,
    customer: { id: idOf(customer.id), category: customer.category || null, name: customer.displayName || customer.companyName || record.customer || "Unknown customer" },
    courier: { code: providerCode, name: record.partnerName || record.carrierName || providerCode || "Unknown courier" },
    trackingOutcome,
    currency: selling?.currency || final?.currency || estimate?.currency || null,
    customerSellingAmount: selling?.amount || null,
    customerSellingCurrency: selling?.currency || null,
    customerChargeBreakdown: snapshotSelling?.modePrice ? structuredClone(snapshotSelling.modePrice) : revenue.chargeBreakdown || null,
    customerRevenueExGst: revenue.amount,
    customerRevenueCurrency: revenue.currency || null,
    revenueTaxAmount: revenue.taxAmount,
    revenueTaxBasisStatus: revenue.status,
    revenueSource: revenue.source,
    estimatedPartnerCost: estimate?.amount || null,
    estimatedPartnerCostCurrency: estimate?.currency || null,
    estimatedPartnerCostBreakdown: estimate?.chargeBreakdown || null,
    estimatedPartnerCostSource: estimate?.source || null,
    estimatedPartnerCostReference: estimate?.reference || null,
    estimatedPartnerCostExGst: estimateNet.amount,
    estimatedCostTaxBasisStatus: estimateNet.status,
    finalPartnerCost: final?.amount || null,
    finalPartnerCostCurrency: final?.currency || null,
    finalPartnerCostBreakdown: final?.chargeBreakdown || null,
    finalPartnerCostSource: final?.source || null,
    finalPartnerCostReference: final?.reference || null,
    finalPartnerCostExGst: finalNet.amount,
    finalCostTaxBasisStatus: finalNet.status,
    costReconciliationStatus: final ? (estimate && (estimate.currency !== final.currency || estimate.amount !== final.amount) ? "DISCREPANT" : "CONFIRMED") : estimate ? "PENDING" : "UNAVAILABLE",
    profitStatus, grossProfit: profit, grossProfitCurrency: profit == null ? null : revenue.currency,
    profitMarginPercent: profit != null && Number(revenue.amount) > 0
      ? Number((Number(profit) / Number(revenue.amount) * 100).toFixed(2))
      : null,
    profitReason,
  };
}

function sum(values) { return values.length ? addDecimals(values) : null; }
function groupRows(rows, keyFunction) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFunction(row) || "Unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}
function currencyTotals(rows) {
  const currencySet = new Set(rows.flatMap(row => [row.customerSellingCurrency, row.customerRevenueCurrency, row.estimatedPartnerCostCurrency, row.finalPartnerCostCurrency, row.grossProfitCurrency]).filter(Boolean));
  return [...currencySet].sort().map(currency => ({
    currency,
    customerSellingAmount: sum(rows.filter(row => row.customerSellingCurrency === currency).map(row => row.customerSellingAmount).filter(value => value != null)),
    customerRevenueExGst: sum(rows.filter(row => row.customerRevenueCurrency === currency).map(row => row.customerRevenueExGst).filter(value => value != null)),
    estimatedPartnerCost: sum(rows.filter(row => row.estimatedPartnerCostCurrency === currency && row.estimatedPartnerCostSource !== "LOCAL_MOCK_ONLY").map(row => row.estimatedPartnerCost).filter(value => value != null)),
    estimatedPartnerCostExGst: sum(rows.filter(row => row.estimatedPartnerCostCurrency === currency).map(row => row.estimatedPartnerCostExGst).filter(value => value != null)),
    finalPartnerCost: sum(rows.filter(row => row.finalPartnerCostCurrency === currency).map(row => row.finalPartnerCost).filter(value => value != null)),
    finalPartnerCostExGst: sum(rows.filter(row => row.finalPartnerCostCurrency === currency).map(row => row.finalPartnerCostExGst).filter(value => value != null)),
    confirmedGrossProfit: sum(rows.filter(row => row.profitStatus === "CONFIRMED" && row.grossProfitCurrency === currency).map(row => row.grossProfit)),
    provisionalGrossProfit: sum(rows.filter(row => row.profitStatus === "PROVISIONAL" && row.grossProfitCurrency === currency).map(row => row.grossProfit)),
    revenueIncompleteCount: rows.filter(row => row.currency === currency && row.customerRevenueExGst == null).length,
    costIncompleteCount: rows.filter(row => row.currency === currency && row.finalPartnerCostExGst == null && row.estimatedPartnerCostExGst == null).length,
  }));
}
function aggregateRows(rows, keyFunction) {
  const groups = groupRows(rows, keyFunction);
  return [...groups].map(([key, list]) => ({
    key, shipmentCount: list.length,
    currencies: currencyTotals(list),
    confirmedCount: list.filter(row => row.profitStatus === "CONFIRMED").length,
    provisionalCount: list.filter(row => row.profitStatus === "PROVISIONAL").length,
    configurationRequiredCount: list.filter(row => row.profitStatus === "CONFIGURATION_REQUIRED").length,
    unavailableCount: list.filter(row => row.profitStatus === "UNAVAILABLE").length,
  }));
}

function courierPerformance(rows) {
  return [...groupRows(rows, row => row.courier.code).entries()].map(([code, shipments]) => {
    const sampleCount = shipments.filter(row => row.trackingOutcome === "SAMPLE").length;
    const mappedCount = shipments.filter(row => row.trackingOutcome && row.trackingOutcome !== "SAMPLE").length;
    return {
      code, name: shipments[0].courier.name, shipmentCount: shipments.length,
      deliveredCount: shipments.filter(row => row.trackingOutcome === "DELIVERED").length,
      inTransitCount: shipments.filter(row => ["IN_TRANSIT", "OUT_FOR_DELIVERY"].includes(row.trackingOutcome)).length,
      exceptionCount: shipments.filter(row => ["FAILED", "EXCEPTION", "DELAYED", "LOST", "DAMAGED", "NDR", "RTO"].includes(row.trackingOutcome)).length,
      unmappedCount: shipments.length - sampleCount - mappedCount, sampleCount,
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
}

function profitPeriods(rows) {
  const weekStart = row => {
    const date = new Date(row.shipmentDate);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    return date.toISOString().slice(0, 10);
  };
  const dated = rows.filter(row => row.shipmentDate);
  const group = key => aggregateRows(dated, key).sort((a, b) => a.key.localeCompare(b.key));
  return {
    daily: group(row => row.shipmentDate.slice(0, 10)),
    weekly: group(weekStart),
    monthly: group(row => row.shipmentDate.slice(0, 7)),
  };
}

function buildCreditBillingSummary(invoices, reportRows) {
  if (!invoices.length) return { status: "UNAVAILABLE", invoices: [], byPeriodCurrency: [], excludedInvoiceCount: 0, reason: "No owner-scoped credit invoice snapshots are linked to the selected shipments." };
  const includedShipments = new Set(reportRows.map(row => row.shipmentId));
  const invoiceRows = [];
  let excludedInvoiceCount = 0;
  let configurationRequired = false;
  for (const invoice of invoices) {
    const lines = invoice.lineItems || [];
    const shipmentIds = [...new Set(lines.map(line => idOf(line.shipmentId)).filter(Boolean))];
    if (!shipmentIds.length || shipmentIds.some(id => !includedShipments.has(id))) { excludedInvoiceCount++; continue; }
    const total = snapshotMoney(invoice.adjustedTotalAmount ?? invoice.totalAmount);
    const paid = snapshotMoney(invoice.paidAmount ?? "0");
    const outstanding = invoice.outstandingAmount == null ? subtractDecimals(total, paid) : snapshotMoney(invoice.outstandingAmount);
    const currency = String(invoice.currency || "").trim().toUpperCase();
    const rowStatus = total == null || paid == null || outstanding == null || !/^[A-Z]{3}$/.test(currency) ? "CONFIGURATION_REQUIRED" : "READY";
    if (rowStatus !== "READY") configurationRequired = true;
    invoiceRows.push({
      invoiceNumber: invoice.invoiceNumber || "Unavailable", customer: invoice.customerSnapshot?.displayName || invoice.customerSnapshot?.companyName || "Unknown customer",
      customerId: idOf(invoice.customerId) || idOf(invoice.customerSnapshot?.id) || null, period: invoice.period?.key || "Unavailable",
      invoiceDate: asDate(invoice.invoiceDate)?.toISOString() || null, currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
      totalAmount: total, paidAmount: paid, outstandingAmount: outstanding, status: invoice.status || "Unavailable", financialStatus: rowStatus,
    });
  }
  const groups = new Map();
  for (const row of invoiceRows) {
    const key = `${row.period}\u0000${row.currency || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const byPeriodCurrency = [...groups.values()].map(rows => ({
    period: rows[0].period, currency: rows[0].currency, invoiceCount: rows.length,
    totalAmount: sum(rows.map(row => row.totalAmount).filter(value => value != null)),
    paidAmount: sum(rows.map(row => row.paidAmount).filter(value => value != null)),
    outstandingAmount: sum(rows.map(row => row.outstandingAmount).filter(value => value != null)),
    status: rows.some(row => row.financialStatus !== "READY") ? "CONFIGURATION_REQUIRED" : "READY",
  })).sort((a, b) => a.period.localeCompare(b.period) || String(a.currency).localeCompare(String(b.currency)));
  const status = configurationRequired || excludedInvoiceCount ? "CONFIGURATION_REQUIRED" : invoiceRows.length ? "READY" : "UNAVAILABLE";
  return {
    status, invoices: invoiceRows, byPeriodCurrency, excludedInvoiceCount,
    reason: excludedInvoiceCount ? "Some invoices contain shipments outside the selected report filters; invoice balances were not apportioned across a partial invoice." : configurationRequired ? "One or more invoice balance snapshots are incomplete." : invoiceRows.length ? "Outstanding values use current owner-scoped invoice balances; they are not historical balances as of the report end date." : "No complete invoice maps wholly to the selected shipment set.",
  };
}

function createProfitabilityReportService({ Shipment, Invoice }) {
  async function run(owner, filters = {}) {
    if (typeof owner !== "string" || !owner.trim()) throw new ProfitabilityReportError("Authenticated owner is invalid.", { status: 401, code: "AUTHENTICATION_REQUIRED" });
    const range = dateRange(filters);
    for (const field of ["customerId", "partnerCode", "shipmentStatus"]) {
      if (filters[field] != null && (typeof filters[field] !== "string" || filters[field].length > 150)) throw new ProfitabilityReportError(`${field} filter is invalid.`);
    }
    if (filters.customerId && !mongoose.isValidObjectId(filters.customerId)) throw new ProfitabilityReportError("customerId must be a valid customer ID.");
    const startDay = range.start.toISOString().slice(0, 10);
    const endDay = range.endExclusive.toISOString().slice(0, 10);
    const shipmentQuery = {
      owner, state: "saved", kind: "forward",
      $or: [
        { "record.date": { $gte: startDay, $lt: endDay } },
        { "record.date": { $gte: range.start, $lt: range.endExclusive } },
        { $and: [
          { createdAt: { $gte: range.start, $lt: range.endExclusive } },
          { $or: [{ "record.date": { $exists: false } }, { "record.date": null }, { "record.date": "" }] },
        ] },
      ],
    };
    if (filters.customerId) shipmentQuery["record.customerSnapshot.id"] = filters.customerId;
    let shipmentQueryBuilder = Shipment.find(shipmentQuery);
    if (shipmentQueryBuilder?.select) shipmentQueryBuilder = shipmentQueryBuilder.select("owner _id reference waybill createdAt record trackingStatus");
    let shipmentRows = await shipmentQueryBuilder.sort({ createdAt: -1, _id: -1 }).limit(MAX_REPORT_SHIPMENTS + 1).lean();
    shipmentRows = shipmentRows.filter(row => { const date = shipmentDate(row); return date && date >= range.start && date < range.endExclusive; });
    if (shipmentRows.length > MAX_REPORT_SHIPMENTS) throw new ProfitabilityReportError(`The selected report exceeds the ${MAX_REPORT_SHIPMENTS} shipment limit. Narrow the date range or filters before exporting.`, { status: 413, code: "PROFITABILITY_REPORT_LIMIT_EXCEEDED" });
    let invoiceQuery = shipmentRows.length ? Invoice.find({ owner, "lineItems.shipmentId": { $in: shipmentRows.map(row => row._id) } }) : null;
    if (invoiceQuery?.select) invoiceQuery = invoiceQuery.select("owner invoiceNumber customerId customerSnapshot period invoiceDate currency status totalAmount adjustedTotalAmount paidAmount outstandingAmount billingConfigurationSnapshot lineItems");
    const invoices = invoiceQuery ? await invoiceQuery.limit(MAX_REPORT_SHIPMENTS + 1).lean() : [];
    if (invoices.length > MAX_REPORT_SHIPMENTS) throw new ProfitabilityReportError(`The selected report references more than ${MAX_REPORT_SHIPMENTS} invoices and cannot be exported safely. Narrow the date range or filters.`, { status: 413, code: "PROFITABILITY_REPORT_LIMIT_EXCEEDED" });
    const invoiceLines = new Map();
    for (const invoice of invoices) for (const line of invoice.lineItems || []) {
      const key = String(line.shipmentId);
      if (!shipmentRows.some(row => String(row._id) === key)) continue;
      invoiceLines.set(key, [...(invoiceLines.get(key) || []), { invoice, line }]);
    }
    const statusMappings = loadStatusMappings();
    const allRows = shipmentRows.map(row => buildShipmentReport(row, invoiceLines, statusMappings));
    const filterOptions = {
      customers: [...new Map(allRows.map(row => [row.customer.id, row.customer]).filter(([id]) => id)).values()].sort((a, b) => a.name.localeCompare(b.name)),
      couriers: [...new Map(allRows.filter(row => row.courier.code).map(row => [row.courier.code, row.courier])).values()].sort((a, b) => a.name.localeCompare(b.name)),
      shipmentStatuses: [...new Set(allRows.map(row => row.shipmentStatus).filter(Boolean))].sort(),
    };
    let rows = allRows;
    if (filters.customerId) rows = rows.filter(row => row.customer.id === filters.customerId);
    if (filters.partnerCode) rows = rows.filter(row => row.courier.code === filters.partnerCode.trim().toUpperCase());
    if (filters.shipmentStatus) rows = rows.filter(row => row.shipmentStatus === filters.shipmentStatus);
    const summary = {
      shipmentCount: rows.length,
      confirmedCount: rows.filter(row => row.profitStatus === "CONFIRMED").length,
      provisionalCount: rows.filter(row => row.profitStatus === "PROVISIONAL").length,
      configurationRequiredCount: rows.filter(row => row.profitStatus === "CONFIGURATION_REQUIRED").length,
      unavailableCount: rows.filter(row => row.profitStatus === "UNAVAILABLE").length,
      currencies: currencyTotals(rows),
    };
    return {
      period: { label: range.label, from: range.start.toISOString(), toExclusive: range.endExclusive.toISOString(), dateBasis: "SHIPMENT_DATE" },
      filters: { customerId: filters.customerId || null, partnerCode: filters.partnerCode?.trim().toUpperCase() || null, shipmentStatus: filters.shipmentStatus || null },
      summary, shipments: rows,
      profitPeriods: profitPeriods(rows),
      customers: aggregateRows(rows, row => row.customer.id ? `${row.customer.name} (${row.customer.id})` : row.customer.name),
      couriers: aggregateRows(rows, row => row.courier.code || row.courier.name),
      courierPerformance: courierPerformance(rows),
      creditBillingSummary: buildCreditBillingSummary(invoices, rows),
      filterOptions,
      notes: ["Customer selling amounts and partner costs are reported separately from gross profit.", "Profit uses customer revenue excluding GST minus partner cost excluding only explicitly recorded recoverable GST.", "Estimated costs are never substituted for final costs; any estimate-based profit is marked PROVISIONAL.", "Currency totals are grouped; no currency conversion is applied."],
    };
  }
  return { run };
}

module.exports = { MAX_REPORT_SHIPMENTS, ProfitabilityReportError, dateRange, customerSellingAmount, invoiceRevenue, partnerAmount, partnerCostExGst, buildShipmentReport, currencyTotals, aggregateRows, buildCreditBillingSummary, createProfitabilityReportService };
