const mongoose = require("mongoose");
const { plainDecimal, subtractDecimals } = require("./creditCustomerBillingService");

const COST_FIELDS = new Set(["baseFreight", "fuelSurcharge", "codCharges", "otherCharges", "taxesAndGst", "total"]);

class PartnerCostError extends Error {
  constructor(message, { status = 400, code = "PARTNER_COST_INVALID" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validObjectId(value) { return mongoose.isValidObjectId(value); }
function decimal(value) { return plainDecimal(value); }

function estimateOf(record = {}) {
  const source = record.estimatedPartnerCostSnapshot || {};
  const quote = record.partnerQuoteSnapshot || {};
  const amount = decimal(source.amount ?? quote.partnerTotal ?? quote.amount);
  const currency = String(source.currency || quote.currency || "").trim().toUpperCase();
  if (amount == null || !/^[A-Z]{3}$/.test(currency)) return null;
  return {
    amount,
    currency,
    source: source.source || "PARTNER_QUOTE",
    quoteId: source.quoteId || quote.id || null,
    quotedAt: source.capturedAt || quote.quotedAt || null,
    chargeBreakdown: structuredClone(source.chargeBreakdown || quote.chargeBreakdown || null),
    apiResponseReference: source.apiResponseReference || quote.id || null,
    originalQuote: structuredClone(quote.estimateSnapshot || source.originalQuote || null),
  };
}

function finalOf(record = {}) {
  const source = record.partnerCostSnapshot;
  if (!source || typeof source !== "object") return null;
  const amount = decimal(source.amount ?? source.totalAmount ?? source.total);
  const currency = String(source.currency || "").trim().toUpperCase();
  if (amount == null || !/^[A-Z]{3}$/.test(currency)) return null;
  return structuredClone({ ...source, amount, currency });
}

function reconciliationStatus(estimate, final) {
  if (!estimate) return final ? "CONFIRMED" : "UNAVAILABLE";
  if (!final) return "PENDING";
  if (estimate.currency !== final.currency) return "DISCREPANT";
  return estimate.amount === final.amount ? "CONFIRMED" : "DISCREPANT";
}

function shipmentCostView(row) {
  const record = row.record || {};
  const estimate = estimateOf(record);
  const final = finalOf(record);
  const status = reconciliationStatus(estimate, final);
  const diff = estimate && final && estimate.currency === final.currency
    ? subtractDecimals(final.amount, estimate.amount)
    : null;
  return {
    shipmentId: String(row._id),
    reference: row.reference || record.reference || "",
    waybill: row.waybill || record.waybill || null,
    shipmentDate: record.date || row.createdAt || null,
    partnerCode: String(record.partnerCode || record.carrierCode || "").toUpperCase(),
    partnerName: record.partnerName || record.carrierName || record.partnerCode || record.carrierCode || "Unknown courier",
    bookingStatus: record.bookingStatus || null,
    estimatedCost: estimate,
    finalCost: final,
    reconciliationStatus: status,
    variance: diff,
    varianceCurrency: diff == null ? null : estimate.currency,
    costAuditTrail: structuredClone(Array.isArray(record.partnerCostAuditTrail) ? record.partnerCostAuditTrail : []),
    reconciliationHistory: structuredClone(Array.isArray(record.partnerCostReconciliations) ? record.partnerCostReconciliations : []),
  };
}

function validateBreakdown(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PartnerCostError("chargeBreakdown must be an object.");
  const unsupported = Object.keys(value).filter(key => !COST_FIELDS.has(key));
  if (unsupported.length) throw new PartnerCostError("chargeBreakdown contains unsupported fields.");
  const result = {};
  for (const [key, amount] of Object.entries(value)) {
    const normalized = decimal(amount);
    if (normalized == null) throw new PartnerCostError(`${key} must be a non-negative decimal amount.`);
    result[key] = normalized;
  }
  return result;
}

function createPartnerCostService({ Shipment, now = () => new Date() }) {
  async function findShipment(owner, shipmentId) {
    if (!validObjectId(shipmentId)) throw new PartnerCostError("Invalid shipment ID.");
    return Shipment.findOne({ _id: shipmentId, owner, state: "saved", kind: "forward" }).lean();
  }

  async function list(owner, { partnerCode, status, from, to } = {}) {
    const rows = await Shipment.find({ owner, state: "saved", kind: "forward" }).sort({ createdAt: -1, _id: -1 }).lean();
    let costs = rows.map(shipmentCostView);
    if (partnerCode) costs = costs.filter(row => row.partnerCode === partnerCode.trim().toUpperCase());
    if (status) costs = costs.filter(row => row.reconciliationStatus === status);
    const start = from ? new Date(from) : null;
    const end = to ? new Date(to) : null;
    if ((from && !Number.isFinite(start.getTime())) || (to && !Number.isFinite(end.getTime()))) throw new PartnerCostError("Date filters must be valid dates.");
    if (start) costs = costs.filter(row => new Date(row.shipmentDate) >= start);
    if (end) costs = costs.filter(row => new Date(row.shipmentDate) < new Date(end.getTime() + 86400000));
    return costs;
  }

  async function detail(owner, shipmentId) {
    const row = await findShipment(owner, shipmentId);
    return row ? shipmentCostView(row) : null;
  }

  async function reconcileFinal({ owner, actor, shipmentId, amount: rawAmount, currency: rawCurrency, sourceReference, invoiceDate, chargeBreakdown, taxBasis, gstRecoverability: rawRecoverableGst, notes, correlationId }) {
    const row = await findShipment(owner, shipmentId);
    if (!row) throw new PartnerCostError("Shipment not found.", { status: 404, code: "SHIPMENT_NOT_FOUND" });
    const record = row.record || {};
    if (!record.partnerCode && !record.carrierCode) throw new PartnerCostError("Shipment has no selected courier partner.", { status: 409, code: "PARTNER_REFERENCE_MISSING" });
    if (record.partnerCostSnapshot) throw new PartnerCostError("An authoritative final partner cost has already been recorded.", { status: 409, code: "FINAL_COST_ALREADY_RECORDED" });
    const amount = decimal(rawAmount);
    if (amount == null) throw new PartnerCostError("Final cost amount must be a non-negative decimal amount.");
    const currency = String(rawCurrency || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new PartnerCostError("A three-letter final cost currency is required.");
    if (typeof sourceReference !== "string" || !sourceReference.trim() || sourceReference.trim().length > 160) throw new PartnerCostError("A provider invoice or statement reference is required before recording final cost.");
    if (notes != null && (typeof notes !== "string" || notes.length > 1000)) throw new PartnerCostError("notes must be 1000 characters or fewer.");
    const parsedDate = invoiceDate == null || invoiceDate === "" ? null : new Date(invoiceDate);
    if (invoiceDate && !Number.isFinite(parsedDate.getTime())) throw new PartnerCostError("invoiceDate must be a valid date.");
    const breakdown = validateBreakdown(chargeBreakdown);
    if (taxBasis != null && (!taxBasis || typeof taxBasis !== "object" || Array.isArray(taxBasis))) throw new PartnerCostError("taxBasis must be an object when supplied.");
    let gstRecoverability = null;
    if (rawRecoverableGst != null && rawRecoverableGst !== "") {
      gstRecoverability = decimal(rawRecoverableGst);
      if (gstRecoverability == null || breakdown?.taxesAndGst == null || !Object.keys(taxBasis || {}).length ||
        subtractDecimals(breakdown.taxesAndGst, gstRecoverability).startsWith("-") ||
        subtractDecimals(amount, gstRecoverability).startsWith("-")) {
        throw new PartnerCostError("Recoverable GST requires a tax basis and cannot exceed the recorded GST or final cost.");
      }
    }

    const finalCost = {
      amount,
      currency,
      source: "PROVIDER_INVOICE_OPERATOR_RECORDED",
      sourceReference: sourceReference.trim(),
      invoiceDate: parsedDate,
      chargeBreakdown: breakdown,
      taxBasis: taxBasis ? structuredClone(taxBasis) : null,
      gstRecoverability,
      notes: (notes || "").trim(),
      capturedAt: new Date(now()).toISOString(),
      capturedBy: String(actor),
    };
    const estimate = estimateOf(record);
    const reconciliation = {
      id: require("node:crypto").randomUUID(),
      status: reconciliationStatus(estimate, finalCost),
      estimatedAmount: estimate?.amount ?? null,
      estimatedCurrency: estimate?.currency ?? null,
      finalAmount: amount,
      finalCurrency: currency,
      variance: estimate && estimate.currency === currency ? subtractDecimals(amount, estimate.amount) : null,
      sourceReference: finalCost.sourceReference,
      reconciledAt: finalCost.capturedAt,
      actor: String(actor),
      ...(correlationId ? { correlationId: String(correlationId).slice(0, 100) } : {}),
    };
    const audit = { action: "FINAL_COST_RECORDED_AND_RECONCILED", actor: String(actor), at: finalCost.capturedAt, sourceReference: finalCost.sourceReference, status: reconciliation.status, ...(correlationId ? { correlationId: String(correlationId).slice(0, 100) } : {}) };
    const updated = await Shipment.findOneAndUpdate(
      { _id: row._id, owner, state: "saved", kind: "forward", updatedAt: row.updatedAt, "record.partnerCostSnapshot": null },
      { $set: { "record.partnerCostSnapshot": finalCost, "record.partnerCostSourceSnapshot": { source: finalCost.source, sourceReference: finalCost.sourceReference, capturedAt: finalCost.capturedAt }, "record.partnerCostReconciliations": [...(record.partnerCostReconciliations || []), reconciliation], "record.partnerCostAuditTrail": [...(record.partnerCostAuditTrail || []), audit] } },
      { new: true, runValidators: true }
    ).lean();
    if (!updated) throw new PartnerCostError("Shipment cost changed while recording. Reload and verify whether a final cost already exists.", { status: 409, code: "PARTNER_COST_CONFLICT" });
    return shipmentCostView(updated);
  }

  return { list, detail, reconcileFinal };
}

module.exports = { PartnerCostError, estimateOf, finalOf, reconciliationStatus, shipmentCostView, validateBreakdown, createPartnerCostService };
