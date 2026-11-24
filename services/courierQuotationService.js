const crypto = require("node:crypto");
const { withSafeReadRetry, singleFlight } = require("../utils/safeReadRetry");
const { safeProviderSnapshot } = require("../utils/delhiveryError");

class PartnerConfigurationError extends Error {
  constructor(message) { super(message); this.name = "PartnerConfigurationError"; }
}

function createPartnerRegistry(adapters = []) {
  const buildMap = currentAdapters => {
    const byCode = new Map();
    for (const adapter of currentAdapters || []) {
      if (!adapter || typeof adapter.code !== "string" || !adapter.code.trim()) throw new PartnerConfigurationError("Each partner adapter requires a code.");
      const code = adapter.code.trim().toUpperCase();
      if (byCode.has(code)) throw new PartnerConfigurationError(`Duplicate partner adapter: ${code}.`);
      if (typeof adapter.quote !== "function") throw new PartnerConfigurationError(`Partner adapter ${code} must provide quote().`);
      byCode.set(code, Object.freeze({ ...adapter, code }));
    }
    return byCode;
  };
  if (typeof adapters !== "function") {
    const byCode = buildMap(adapters);
    return Object.freeze({
      list: () => [...byCode.values()],
      get: code => byCode.get(String(code || "").trim().toUpperCase()) || null,
    });
  }
  const resolveMap = () => buildMap(adapters());
  return Object.freeze({
    list: () => [...resolveMap().values()],
    get: code => resolveMap().get(String(code || "").trim().toUpperCase()) || null,
  });
}

function partnerInputFromDraft(draftData = {}) {
  const form = draftData.formData || {};
  return {
    originPincode: String(draftData.warehouseSnapshot?.pincode || draftData.pickupSnapshot?.pincode || (form.pickupChoice === "sameAsShipper" ? form.shipperPincode : "") || ""),
    destinationPincode: String(form.pincode || ""),
    chargeableWeightKg: Number(form.chargeableWeightKg) || 0,
    mode: String(form.mode || "").trim().toUpperCase(),
    paymentType: String(form.payment || "").trim().toUpperCase(),
    codAmount: String(form.payment || "").trim().toUpperCase() === "COD" ? Number(form.value) || 0 : 0,
    packageRows: Array.isArray(draftData.packageRows) ? draftData.packageRows : [],
  };
}

function createDraftInputFingerprint(draftData = {}, draftId = "", { compareModes = false } = {}) {
  const quoteInput = {
    draftId: String(draftId || ""),
    ...partnerInputFromDraft(draftData),
    ...(compareModes && { mode: "COMPARE_MODES" }),
    customerSnapshot: draftData.customerSnapshot || null,
    rateCardSnapshot: draftData.rateCardSnapshot || null,
    pricingSnapshot: draftData.pricingSnapshot || null,
    shipperSnapshot: draftData.shipperSnapshot || null,
    consigneeSnapshot: draftData.consigneeSnapshot || null,
    pickupSnapshot: draftData.pickupSnapshot || null,
    warehouseSnapshot: draftData.warehouseSnapshot || null,
    destinationSnapshot: draftData.destinationSnapshot || null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(quoteInput)).digest("hex");
}

function validateQuote(adapter, result, now = new Date()) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new PartnerConfigurationError(`${adapter.code} returned an invalid quotation.`);
  const amount = Number(result.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new PartnerConfigurationError(`${adapter.code} returned an invalid quotation amount.`);
  const currency = String(result.currency || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new PartnerConfigurationError(`${adapter.code} quotation currency is invalid.`);
  return Object.freeze({
    id: crypto.randomUUID(),
    partnerCode: adapter.code,
    partnerName: String(adapter.name || adapter.code).trim(),
    serviceCode: String(result.serviceCode || "").trim(),
    serviceName: String(result.serviceName || result.serviceCode || adapter.name || adapter.code).trim(),
    mode: String(result.mode || "").trim().toUpperCase(),
    amount,
    currency,
    status: "QUOTED",
    quotedAt: now.toISOString(),
    expiresAt: result.expiresAt ? new Date(result.expiresAt).toISOString() : null,
    eta: result.eta ?? result.estimatedDelivery ?? null,
    serviceable: typeof result.serviceable === "boolean" ? result.serviceable : null,
    chargeBreakdown: result.chargeBreakdown && typeof result.chargeBreakdown === "object" ? structuredClone(result.chargeBreakdown) : null,
    partnerTotal: Number.isFinite(Number(result.partnerTotal)) ? Number(result.partnerTotal) : amount,
    provenance: result.provenance === "LOCAL_MOCK" ? "LOCAL_MOCK" : "PROVIDER_ESTIMATE",
    estimateSnapshot: result.estimateSnapshot && typeof result.estimateSnapshot === "object" ? structuredClone(result.estimateSnapshot) : null,
  });
}

async function requestPartnerQuotes(registry, context, { now = () => new Date(), retry = withSafeReadRetry, flight = singleFlight } = {}) {
  const adapters = registry.list();
  if (!adapters.length) return { status: "CONFIGURATION_REQUIRED", quotes: [], unavailable: [], message: "No courier quotation adapters are configured." };
  const outcomes = await Promise.all(adapters.map(async adapter => {
    try {
      const input = Object.freeze(structuredClone(context));
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const result = await flight(`quote:${adapter.code}:${fingerprint}`, () => retry(() => adapter.quote(input), { policy: "providerQuote" }));
      return { quote: validateQuote(adapter, result, now()) };
    } catch (error) {
      let reason = safeProviderSnapshot(String(error?.message || "Quotation unavailable."));
      if (adapter.code === "DELHIVERY" && (error?.isAxiosError || Number.isInteger(error?.response?.status))) {
        const status = error.response?.status;
        reason = ["ECONNABORTED", "ETIMEDOUT"].includes(error.code) ? "Delhivery cost lookup timed out." :
          Number.isInteger(status) ? `Delhivery cost lookup failed (carrier HTTP ${status}).` : "The backend could not reach Delhivery for a cost estimate.";
      }
      return { unavailable: { partnerCode: adapter.code, partnerName: adapter.name || adapter.code, reason } };
    }
  }));
  const quotes = outcomes.flatMap(row => row.quote ? [row.quote] : []);
  const unavailable = outcomes.flatMap(row => row.unavailable ? [row.unavailable] : []);
  return { status: quotes.length ? "QUOTED" : "UNAVAILABLE", quotes, unavailable };
}

function partnerCostSnapshots(quote) {
  return {
    partnerQuoteSnapshot: quote ? structuredClone(quote) : null,
    estimatedPartnerCostSnapshot: quote?.id ? { amount: quote.partnerTotal ?? quote.amount, currency: quote.currency,
      source: quote.provenance === "LOCAL_MOCK" ? "LOCAL_MOCK_ONLY" : "PARTNER_QUOTE", quoteId: quote.id, capturedAt: quote.quotedAt } : null,
  };
}

module.exports = { PartnerConfigurationError, createPartnerRegistry, createDraftInputFingerprint, partnerInputFromDraft, requestPartnerQuotes, validateQuote, partnerCostSnapshots };
