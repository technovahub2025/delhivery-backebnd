const express = require("express");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const requireSession = require("../utils/requireSession");
const { requestPartnerQuotes, createDraftInputFingerprint, partnerInputFromDraft, validateQuote, partnerCostSnapshots } = require("./courierQuotationService");
const { buildPricingSnapshot } = require("./customerPricingService");
const { withSafeReadRetry, singleFlight } = require("../utils/safeReadRetry");
const { findRegisteredWarehouse, snapshotFromWarehouse, applyWarehouseToForm, sameRegisteredWarehouseSnapshot } = require("./warehouseValidation");
const { isDelhiveryFeatureEnabled } = require("../utils/delhiveryFeatureFlags");
const { mapProviderStatus } = require("./providerStatusMappings");

async function summarizeQuotePartnerPerformance(Shipment, owner, quotes, statusMappings) {
  const codes = [...new Set(quotes.filter(quote => !["MOCK_LOCAL", "SAMPLE"].includes(quote.partnerCode) &&
    !["LOCAL_MOCK", "SAMPLE"].includes(quote.provenance)).map(quote => quote.partnerCode))];
  if (!codes.length || typeof Shipment.aggregate !== "function") return [];
  const grouped = await Shipment.aggregate([
    { $match: { owner, state: "saved", kind: { $in: ["forward", null] }, "record.mockOnly": { $ne: true } } },
    { $project: {
      partner: { $ifNull: ["$record.partnerCode", { $ifNull: ["$record.providerCode", "$record.carrierCode"] }] },
      rawStatus: { $ifNull: ["$trackingStatus", ""] },
    } },
    { $match: { partner: { $in: codes } } },
    { $group: { _id: { partner: "$partner", rawStatus: "$rawStatus" }, count: { $sum: 1 } } },
  ]).option({ maxTimeMS: 2000 });
  return codes.map(code => {
    const counts = { shipmentCount: 0, mappedCount: 0, deliveredCount: 0, exceptionCount: 0 };
    for (const row of grouped.filter(entry => entry._id.partner === code)) {
      counts.shipmentCount += row.count;
      const status = mapProviderStatus(code, "shipment", row._id.rawStatus, statusMappings);
      if (status) counts.mappedCount += row.count;
      if (status === "DELIVERED") counts.deliveredCount += row.count;
      if (["FAILED", "EXCEPTION", "DELAYED", "LOST", "DAMAGED", "NDR", "RTO"].includes(status)) counts.exceptionCount += row.count;
    }
    return { code, name: quotes.find(quote => quote.partnerCode === code).partnerName, ...counts };
  });
}

function validateBookingDraft(data) {
  const form = data.formData || {};
  for (const key of ["reference", "warehouse", "customer", "address", "destination", "state", "pincode", "phone"])
    if (!String(form[key] || "").trim()) return `${key} is required before booking.`;
  if (!/^\d{6}$/.test(String(form.pincode))) return "A valid destination pincode is required.";
  if (!data.warehouseSnapshot?.id || data.warehouseSnapshot.registrationStatus !== "REGISTERED" || !data.warehouseSnapshot?.name || !/^\d{6}$/.test(String(data.warehouseSnapshot.pincode || ""))) return "Select a registered warehouse with a valid pickup pincode.";
  const payment = String(form.payment || "").trim().toUpperCase();
  if (!["COD", "PREPAID", "PRE-PAID"].includes(payment)) return "Select COD or Prepaid payment before booking.";
  if (String(form.value ?? "").trim() === "" || !Number.isFinite(Number(form.value)) || Number(form.value) < 0 || (payment === "COD" && Number(form.value) <= 0)) return "Order value/COD amount is invalid.";
  if (!["SURFACE", "EXPRESS"].includes(String(form.mode || "").trim().toUpperCase())) return "Select Surface or Express mode before booking.";
  const boxes = data.packageRows;
  if (!Array.isArray(boxes) || boxes.length < 1 || boxes.length > 5) return "At least one and no more than five package rows are required.";
  for (const [index, box] of boxes.entries()) {
    const values = [Number(box.boxes), Number(box.length), Number(box.width), Number(box.height), Number(box.weight)];
    if (!values.every(Number.isFinite) || values.some(value => value <= 0)) return `Package row ${index + 1} must have positive count, dimensions and weight.`;
    if (!["cm", "inch"].includes(String(box.unit || "").toLowerCase()) || !["gm", "kg"].includes(String(box.weightUnit || "").toLowerCase())) return `Package row ${index + 1} has unsupported measurement units.`;
  }
  if (!(Number(form.chargeableWeightKg) > 0)) return "A positive chargeable weight is required before booking.";
  return null;
}

function validateBookingPricing(data, mode) {
  const customer = data.customerSnapshot;
  const rateCard = data.rateCardSnapshot;
  const pricing = data.pricingSnapshot;
  if (!customer?.id || !customer.category || !(customer.displayName || customer.companyName)) {
    return { code: "BOOKING_SNAPSHOT_INCOMPLETE", message: "Customer snapshot is missing; refresh the draft from its selected customer before booking." };
  }
  if (!rateCard?.id || !rateCard.scope || !Number.isInteger(Number(rateCard.version)) || Number(rateCard.version) < 1) {
    return { code: "BOOKING_SNAPSHOT_INCOMPLETE", message: "Assigned rate-card snapshot is missing or incomplete; refresh the draft from the customer's assigned rate card before booking." };
  }
  if (!pricing || typeof pricing !== "object") {
    return { code: "BOOKING_PRICING_CONFIGURATION_REQUIRED", message: "Customer selling-price snapshot is missing; refresh pricing before booking.", details: { blockers: ["Pricing snapshot is missing."] } };
  }
  const blockers = Array.isArray(pricing.blockers) ? pricing.blockers.filter(item => typeof item === "string" && item.trim()) : [];
  const pricingStatus = String(pricing.status || "").toUpperCase();
  if (["CONFIGURATION_REQUIRED", "UNAVAILABLE"].includes(pricingStatus)) {
    return {
      code: "BOOKING_PRICING_CONFIGURATION_REQUIRED",
      message: `Customer selling-price configuration is ${pricingStatus} for ${mode}; resolve the listed pricing rules before booking.`,
      details: { pricingStatus, mode, blockers },
    };
  }
  if (!["READY", "TEST", "PARTIAL"].includes(pricingStatus)) {
    return { code: "BOOKING_PRICING_CONFIGURATION_REQUIRED", message: "Customer selling-price snapshot has no usable calculation status; refresh pricing before booking.", details: { pricingStatus: pricing.status || null, mode, blockers } };
  }
  if (!pricing.card?.id || String(pricing.card.id) !== String(rateCard.id) || Number(pricing.card.version) !== Number(rateCard.version) || pricing.card.scope !== rateCard.scope || String(pricing.card.customerId || "") !== String(rateCard.customerId || "")) {
    return { code: "BOOKING_SNAPSHOT_INCOMPLETE", message: "Pricing snapshot does not match the assigned rate-card snapshot; refresh pricing before booking." };
  }
  const cardConfiguration = pricing.rateCardConfiguration;
  if (!cardConfiguration || !Array.isArray(cardConfiguration.zoneRates) || !cardConfiguration.zoneRates.length || !Array.isArray(cardConfiguration.surcharges) || !Array.isArray(cardConfiguration.gstRules)) {
    return { code: "BOOKING_PRICING_CONFIGURATION_REQUIRED", message: "Pricing snapshot is missing its rate-card configuration details; refresh pricing before booking.", details: { blockers: ["Rate-card pricing configuration snapshot is missing or incomplete."] } };
  }
  const category = String(customer.category).toUpperCase();
  const compatible = category === "WALK_IN"
    ? rateCard.scope === "WALK_IN_STANDARD" && rateCard.customerId == null
    : category === "CREDIT" && rateCard.scope === "CUSTOMER" && String(rateCard.customerId) === String(customer.id);
  if (!compatible) {
    return { code: "BOOKING_SNAPSHOT_INCOMPLETE", message: "Customer and assigned rate-card snapshots are incompatible; refresh the customer and pricing snapshots before booking." };
  }
  if (customer.rateCardId && String(customer.rateCardId) !== String(rateCard.id)) {
    return { code: "BOOKING_SNAPSHOT_INCOMPLETE", message: "Customer snapshot assignment does not match the saved rate-card snapshot; refresh the customer and pricing snapshots before booking." };
  }
  const selling = pricing.customerSelling?.[mode];
  if (!selling || !["READY", "TEST"].includes(String(selling.status || "").toUpperCase()) || selling.sellingPrice == null || !Number.isFinite(Number(selling.sellingPrice)) || Number(selling.sellingPrice) < 0 || !/^[A-Z]{3}$/.test(String(selling.currency || "").toUpperCase())) {
    const modeBlockers = Array.isArray(selling?.blockers) ? selling.blockers.filter(item => typeof item === "string" && item.trim()) : [];
    return {
      code: "BOOKING_PRICING_CONFIGURATION_REQUIRED",
      message: `Customer selling price for ${mode} is missing or not calculation-ready; refresh pricing before booking.`,
      details: { pricingStatus: selling?.status || "MISSING", mode, blockers: modeBlockers.length ? modeBlockers : ["A valid selling price and currency are required for the selected mode."] },
    };
  }
  const calculatedAt = Date.parse(pricing.calculatedAt || "");
  const inputs = pricing.inputs;
  if (!Number.isFinite(calculatedAt) || !inputs || !String(inputs.zone || "").trim() || !(Number(inputs.chargeableWeight) > 0)) {
    return { code: "BOOKING_PRICING_CONFIGURATION_REQUIRED", message: "Pricing snapshot is missing the inputs or calculation time needed to validate the customer selling price; refresh pricing before booking.", details: { mode, blockers: ["Pricing inputs or calculatedAt are missing."] } };
  }
  const form = data.formData || {};
  const expectedZone = String(data.destinationSnapshot?.zone || form.destinationZone || "").trim();
  const expectedPaymentType = String(form.payment || "").trim().toUpperCase() === "COD" ? "COD" : "PREPAID";
  const expectedCodAmount = expectedPaymentType === "COD" ? Number(form.value) || 0 : 0;
  if (String(inputs.zone).trim() !== expectedZone || Number(inputs.chargeableWeight) !== Number(form.chargeableWeightKg) || String(inputs.paymentType || "").toUpperCase() !== expectedPaymentType || Number(inputs.codAmount || 0) !== expectedCodAmount) {
    return { code: "BOOKING_PRICING_CONFIGURATION_REQUIRED", message: "Customer selling-price snapshot was calculated with different zone, weight, or payment inputs; refresh pricing before booking.", details: { mode, blockers: ["Pricing inputs do not match the current draft."] } };
  }
  const recalculated = buildPricingSnapshot({
    _id: pricing.card.id,
    name: pricing.card.name || rateCard.name,
    scope: pricing.card.scope,
    customerId: pricing.card.customerId,
    version: pricing.card.version,
    currency: pricing.card.currency,
    ...cardConfiguration,
  }, inputs, { now: new Date(calculatedAt) });
  const recalculatedMode = recalculated.customerSelling?.[mode];
  if (recalculated.status !== pricingStatus || !recalculatedMode || recalculatedMode.status !== selling.status || Number(recalculatedMode.sellingPrice) !== Number(selling.sellingPrice) || String(recalculatedMode.currency || "").toUpperCase() !== String(selling.currency || "").toUpperCase()) {
    return { code: "BOOKING_PRICING_CONFIGURATION_REQUIRED", message: "Customer selling-price snapshot does not match a valid calculation from its stored rate-card rules; refresh pricing before booking.", details: { pricingStatus: recalculated.status, mode, blockers: recalculatedMode?.blockers || ["Stored selling price is inconsistent with the rate-card configuration snapshot."] } };
  }
  return null;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
  }
  return value;
}

function isFreshQuoteBatch(batch, data, draftId) {
  const activeBatches = (data.partnerQuoteBatches || []).filter(item => item && !item.archived);
  const newestBatch = activeBatches.at(-1);
  return Boolean(batch && !batch.archived && batch.id === data.activePartnerQuoteBatchId && newestBatch?.id === batch.id &&
    Number.isFinite(Date.parse(batch.requestedAt || "")) && batch.inputFingerprint &&
    batch.inputFingerprint === createDraftInputFingerprint(data, draftId, { compareModes: batch.compareModes === true }));
}

function validateSelectedQuote(quote, batch, data, draftId, now = Date.now()) {
  if (quote?.bookable === false) return { code: "BOOKING_ADAPTER_UNAVAILABLE", message: "This quotation is an estimate only. Carrier booking is unavailable." };
  if (!quote || !batch || !isFreshQuoteBatch(batch, data, draftId)) {
    return { code: "QUOTE_STALE", message: "The selected quotation does not belong to the current draft inputs. Request and select a fresh quotation." };
  }
  const batchQuote = (batch.quotes || []).find(item => item?.id === quote.id);
  if (!batchQuote || JSON.stringify(canonicalJson(batchQuote)) !== JSON.stringify(canonicalJson(quote))) {
    return { code: "QUOTE_NOT_CURRENT", message: "The selected quotation does not match a quotation in the active batch for this draft. Select a current quotation." };
  }
  if (quote.status !== "QUOTED" || !String(quote.partnerCode || "").trim() || !String(quote.partnerName || "").trim() || !Number.isFinite(Number(quote.amount)) || Number(quote.amount) < 0 || !/^[A-Z]{3}$/.test(String(quote.currency || "").toUpperCase())) {
    return { code: "QUOTE_NOT_CURRENT", message: "The selected quotation is missing valid partner quote details. Request a fresh quotation." };
  }
  if (quote.mode !== String(data.formData?.mode || "").trim().toUpperCase()) {
    return { code: "QUOTE_NOT_CURRENT", message: "The quotation does not match the draft shipping mode." };
  }
  if (quote.serviceable === false) {
    return { code: "QUOTE_NOT_SERVICEABLE", message: "This courier quotation is marked not serviceable for the destination." };
  }
  const quotedAt = Date.parse(quote.quotedAt || "");
  const requestedAt = Date.parse(batch.requestedAt || "");
  if (!Number.isFinite(quotedAt) || !Number.isFinite(requestedAt) || quotedAt < requestedAt || quotedAt > now + 60_000) {
    return { code: "QUOTE_NOT_CURRENT", message: "The selected quotation has invalid or out-of-order timestamps. Request a fresh quotation." };
  }
  if (quote.expiresAt != null) {
    const expiresAt = Date.parse(quote.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return { code: "QUOTE_EXPIRED", message: "The selected quotation has expired. Request fresh quotations." };
  }
  return null;
}

function buildBookedRecord({ data = {}, quote = {}, waybill = "", reference = "", bookingStatus = "AWB_GENERATED", providerRecord = {}, finalPartnerCostSnapshot = null }) {
  const form = data.formData || {};
  return {
    ...(providerRecord && typeof providerRecord === "object" ? structuredClone(providerRecord) : {}),
    id: waybill || `BOOKED-${reference}`, waybill, reference, partnerCode: quote.partnerCode || "", partnerName: quote.partnerName || "",
    mode: form.mode || quote.mode || "", payment: form.payment || "", value: Number(form.value) || 0,
    customer: form.customer || "", address: form.address || "", destination: form.destination || "", state: form.state || "", pincode: String(form.pincode || ""),
    phone: String(form.phone || ""), email: form.email || "", warehouse: form.warehouse || "", weight: Number(form.weight || form.actualWeightKg) || 0,
    dimensions: [form.length, form.width, form.height].filter(Boolean).join(" x "), ewaybill: "", date: new Date().toISOString().slice(0, 10), status: "Pending pickup", history: [],
    customerSnapshot: structuredClone(data.customerSnapshot || null), rateCardSnapshot: structuredClone(data.rateCardSnapshot || null),
    rateCardConfigurationSnapshot: structuredClone(data.pricingSnapshot?.rateCardConfiguration || null),
    customerSellingPriceSnapshot: structuredClone(data.pricingSnapshot || null),
    customerTaxBasisSnapshot: structuredClone(data.pricingSnapshot?.taxBasis || data.pricingSnapshot?.gst || null),
    ...partnerCostSnapshots(quote),
    partnerCostSnapshot: finalPartnerCostSnapshot || null,
    partnerCostSourceSnapshot: finalPartnerCostSnapshot ? { source: finalPartnerCostSnapshot.source || "PROVIDER_CONFIRMED", capturedAt: new Date().toISOString() } : null,
    bookingStatus,
    shipperSnapshot: structuredClone(data.shipperSnapshot || null), consigneeSnapshot: structuredClone(data.consigneeSnapshot || null),
    pickupSnapshot: structuredClone(data.pickupSnapshot || null), warehouseSnapshot: structuredClone(data.warehouseSnapshot || null),
    destinationSnapshot: structuredClone(data.destinationSnapshot || null), packageRows: structuredClone(data.packageRows || []),
    productCategory: form.productCategory || "", handlingInstructions: form.handlingInstructions || "", fragile: form.fragile === true,
  };
}

module.exports = function shipmentQuoteRouter({
  Shipment, Customer, Warehouse, partnerRegistry, getEnvironment = () => process.env,
  statusMappings = {},
  getReconciliationAdapter = code => partnerRegistry.get(code),
}) {
  const router = express.Router();
  router.use("/shipments/drafts", requireSession);

  router.post("/shipments/drafts/:id/quotes", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid draft ID." });
    const source = req.body?.source ?? "live";
    if (!["live", "sample"].includes(source)) return res.status(400).json({ success: false, message: "Invalid quotation source." });
    try {
      const row = await Shipment.findOne({ _id: req.params.id, owner: req.user.id, state: "draft", kind: "forward" }).lean();
      if (!row) return res.status(404).json({ success: false, message: "Draft not found." });
      const data = row.draftData || {};
      const context = Object.freeze({
        draftId: String(row._id),
        customerPricingSnapshot: data.pricingSnapshot || null,
        partnerInput: Object.freeze(partnerInputFromDraft(data)),
      });
      const requestedAt = new Date().toISOString();
      const compareModes = req.body?.compareModes === true;
      const quotationRegistry = partnerRegistry.quotations?.(source) || partnerRegistry;
      const quoteModes = compareModes ? ["SURFACE", "EXPRESS"] : [context.partnerInput.mode];
      const results = await Promise.all(quoteModes.map(async mode => {
        const result = await requestPartnerQuotes(quotationRegistry, {
          ...context, partnerInput: { ...context.partnerInput, mode },
        });
        return { ...result,
          quotes: result.quotes.filter(quote => !compareModes || quote.mode === mode),
          unavailable: result.unavailable.map(item => ({ ...item, ...(compareModes && { mode }) })),
        };
      }));
      const quotes = results.flatMap(result => result.quotes).map(quote => ({
        ...quote, ...(partnerRegistry.canBook && { bookable: partnerRegistry.canBook(quote.partnerCode) }),
      }));
      const unavailable = results.flatMap(result => result.unavailable);
      const status = quotes.length ? "QUOTED" : results.every(result => result.status === "CONFIGURATION_REQUIRED") ? "CONFIGURATION_REQUIRED" : "UNAVAILABLE";
      const message = status === "CONFIGURATION_REQUIRED" ? source === "sample"
        ? "Sample quotations are available only in isolated mock mode."
        : "Live courier cost estimation is disabled." : undefined;
      let historicalPerformance = [];
      let performanceUnavailable = false;
      if (compareModes) {
        try { historicalPerformance = await summarizeQuotePartnerPerformance(Shipment, req.user.id, quotes, statusMappings); }
        catch { performanceUnavailable = true; }
      }
      const batch = { id: randomUUID(), requestedAt, source, inputFingerprint: createDraftInputFingerprint(data, row._id, { compareModes }), status, quotes, unavailable, ...(compareModes && { compareModes, historicalPerformance, performanceUnavailable }) };
      const previousBatches = Array.isArray(data.partnerQuoteBatches) ? data.partnerQuoteBatches : [];
      const quoteBatches = [...previousBatches.map(item => item.archived ? item : { ...item, archived: true }), batch];
      const updated = await Shipment.findOneAndUpdate(
        { _id: row._id, owner: req.user.id, state: "draft", kind: "forward", updatedAt: row.updatedAt },
        { $set: { "draftData.partnerQuoteBatches": quoteBatches, "draftData.activePartnerQuoteBatchId": batch.id, "draftData.selectedPartnerQuote": null } },
        { new: true, runValidators: true }
      ).lean();
      if (!updated) return res.status(404).json({ success: false, message: "Draft not found." });
      return res.json({ success: true, data: { status: batch.status, quoteBatch: batch, selectedPartnerQuote: null, message } });
    } catch (error) {
      return res.status(503).json({ success: false, message: "Courier quotations could not be obtained or saved." });
    }
  });

  router.get("/shipments/drafts/:id/booking-status", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid booking ID." });
    try {
      const row = await Shipment.findOne({ _id: req.params.id, owner: req.user.id, kind: "forward" }).select("state waybill record receipt reference draftData").lean();
      if (!row) return res.status(404).json({ success: false, message: "Booking not found." });
      const attempt = row.draftData?.bookingAttempt || null;
      const status = row.state === "saved" ? (row.waybill ? "AWB_GENERATED" : row.record?.bookingStatus || "BOOKED_AWB_PENDING") : row.state === "creating" ? (attempt?.status || "OUTCOME_UNCONFIRMED") : row.state.toUpperCase();
      return res.json({ success: true, data: { status, waybill: row.waybill || null, shipment: row.record || null, receipt: row.receipt || null, reference: row.reference, bookingAttempt: attempt } });
    } catch { return res.status(503).json({ success: false, message: "Booking status could not be loaded." }); }
  });

  router.post("/shipments/drafts/:id/book", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid draft ID." });
    try {
      const row = await Shipment.findOne({ _id: req.params.id, owner: req.user.id, state: "draft", kind: "forward" }).lean();
      if (!row) return res.status(404).json({ success: false, message: "Draft not found or already submitted." });
      const data = row.draftData || {};
      const form = data.formData || {};
      const validationError = validateBookingDraft(data);
      if (validationError) return res.status(400).json({ success: false, code: "BOOKING_PREFLIGHT_FAILED", message: validationError });
      const mode = String(form.mode || "").trim().toUpperCase();
      const pricingError = validateBookingPricing(data, mode);
      if (pricingError) return res.status(409).json({ success: false, ...pricingError });
      const quote = data.selectedPartnerQuote;
      const activeBatch = (data.partnerQuoteBatches || []).find(batch => batch.id === data.activePartnerQuoteBatchId && !batch.archived);
      if (!quote || !activeBatch) return res.status(409).json({ success: false, code: "COURIER_SELECTION_REQUIRED", message: "Select a current courier quotation before booking." });
      const quoteError = validateSelectedQuote(quote, activeBatch, data, row._id);
      if (quoteError) return res.status(409).json({ success: false, ...quoteError });
      const adapter = partnerRegistry.get(quote.partnerCode);
      if (!adapter || typeof adapter.book !== "function") return res.status(409).json({ success: false, code: "BOOKING_ADAPTER_UNAVAILABLE", message: "The selected courier booking adapter is not configured." });
      const isDelhivery = adapter.code === "DELHIVERY";
      if (isDelhivery && !isDelhiveryFeatureEnabled("SHIPMENT_BOOKING", getEnvironment())) return res.status(503).json({ success: false, code: "DELHIVERY_FEATURE_DISABLED", message: "Delhivery shipment booking is disabled. No provider request was sent." });
      if (isDelhivery && (data.packageRows.length !== 1 || Number(data.packageRows[0].boxes) !== 1)) {
        return res.status(409).json({ success: false, code: "DELHIVERY_MPS_UNAVAILABLE", message: "Delhivery multi-piece booking is unavailable. No booking request was sent." });
      }
      if (isDelhivery && data.pricingSnapshot.customerSelling[mode]?.status !== "READY") {
        return res.status(409).json({ success: false, code: "BOOKING_PRICING_CONFIGURATION_REQUIRED", message: "Live booking requires an approved selling-price snapshot." });
      }
      const customerId = data.customerSnapshot.id;
      const customer = String(form.bookingCustomerId || "") === String(customerId) && mongoose.isValidObjectId(customerId)
        ? await Customer.findOne({ _id: customerId, owner: req.user.id }).lean() : null;
      if (!customer) return res.status(409).json({ success: false, code: "BOOKING_CUSTOMER_INVALID", message: "Select a customer belonging to this account and save the draft again." });
      const reference = String(form.reference || "").trim();
      if (!reference) return res.status(400).json({ success: false, message: "An order reference is required before booking." });
      const collision = await Shipment.findOne({ owner: req.user.id, reference }).lean();
      if (collision && String(collision._id) !== String(row._id)) return res.status(409).json({ success: false, message: "This order reference is already reserved." });
      const registeredWarehouse = await findRegisteredWarehouse(Warehouse, req.user.id, form.warehouseId);
      if (!registeredWarehouse) return res.status(409).json({ success: false, code: "WAREHOUSE_INVALID", message: "Selected warehouse is no longer registered for this account. Reload the warehouse list before booking." });
      const currentWarehouseSnapshot = snapshotFromWarehouse(registeredWarehouse);
      if (!sameRegisteredWarehouseSnapshot(data.warehouseSnapshot, currentWarehouseSnapshot)) {
        return res.status(409).json({ success: false, code: "WAREHOUSE_CHANGED", message: "Warehouse details changed after this draft was saved. Update the draft and request a fresh courier quotation before booking." });
      }
      const bookingData = {
        ...data,
        formData: applyWarehouseToForm(form, currentWarehouseSnapshot),
        warehouseSnapshot: currentWarehouseSnapshot,
      };
      let serviceable = quote.serviceable === true;
      if (typeof adapter.checkServiceability === "function") {
        try {
          serviceable = await withSafeReadRetry(() => adapter.checkServiceability({ pincode: form.pincode, paymentType: form.payment }), { policy: "providerRead" });
        } catch {
          return res.status(503).json({ success: false, code: "BOOKING_SERVICEABILITY_UNAVAILABLE", message: "Courier serviceability could not be verified. No booking request was sent." });
        }
      } else if (isDelhivery) {
        serviceable = false;
      }
      if (serviceable !== true) return res.status(409).json({ success: false, code: "QUOTE_NOT_SERVICEABLE", message: "The courier has not confirmed serviceability for this shipment." });
      if (isDelhivery && quote.expiresAt == null) {
        let currentQuote;
        try {
          const result = await withSafeReadRetry(() => adapter.quote({ partnerInput: partnerInputFromDraft(bookingData) }), { policy: "providerQuote" });
          currentQuote = validateQuote(adapter, result);
        } catch {
          return res.status(503).json({ success: false, code: "BOOKING_QUOTE_UNAVAILABLE", message: "The selected quotation could not be verified. No booking request was sent." });
        }
        if (currentQuote.serviceable === false || ["serviceCode", "mode", "amount", "partnerTotal", "currency"].some(key => currentQuote[key] !== quote[key])) {
          return res.status(409).json({ success: false, code: "QUOTE_STALE", message: "The courier quotation changed. Request and select a fresh quotation." });
        }
      }
      const finalQuoteError = validateSelectedQuote(quote, activeBatch, data, row._id);
      if (finalQuoteError) return res.status(409).json({ success: false, ...finalQuoteError });
      await Shipment.init();
      const idempotencyKey = randomUUID();
      const providerReference = isDelhivery ? "CMS-" + idempotencyKey.replaceAll("-", "") : undefined;
      const reservation = await Shipment.findOneAndUpdate(
        { _id: row._id, owner: req.user.id, state: "draft", kind: "forward", updatedAt: row.updatedAt },
        { $set: { state: "creating", reference, "draftData.bookingRequestedAt": new Date().toISOString(), "draftData.bookingAttempt": { status: "BOOKING_PENDING", requestedAt: new Date().toISOString(), partnerCode: quote.partnerCode, quoteId: quote.id, idempotencyKey, ...(providerReference && { providerReference }) } } },
        { new: true, runValidators: true }
      ).lean();
      if (!reservation) return res.status(409).json({ success: false, message: "Draft changed during booking preparation. Reload and review it." });

      let result;
      try { result = await adapter.book(Object.freeze({ draftSnapshot: structuredClone(bookingData), selectedQuote: structuredClone(quote), ...(providerReference && { providerReference }) })); }
      catch (error) {
        if (error?.definitive === true || error?.outcome === "REJECTED") {
          await Shipment.findOneAndUpdate({ _id: row._id, owner: req.user.id, state: "creating", kind: "forward", reference }, { $set: { state: "draft", reference: `DRAFT-${row._id}`, "draftData.bookingAttempt.status": "BOOKING_REJECTED", "draftData.bookingAttempt.completedAt": new Date().toISOString(), "draftData.bookingAttempt.reason": "Provider rejected booking." } }, { new: true, runValidators: true }).lean();
          return res.status(422).json({ success: false, code: "BOOKING_REJECTED", message: "The courier definitively rejected the booking. No shipment was created; review the details before trying again." });
        }
        await Shipment.findOneAndUpdate({ _id: row._id, owner: req.user.id, state: "creating", kind: "forward", reference }, { $set: { "draftData.bookingAttempt.status": "OUTCOME_UNCONFIRMED" } }, { new: true, runValidators: true }).lean();
        return res.status(502).json({ success: false, code: "BOOKING_OUTCOME_UNCONFIRMED", message: "The courier did not confirm booking. Check booking status before any further action.", bookingStatusPath: "/shipments/drafts/" + row._id + "/booking-status" });
      }
      const waybill = String(result?.waybill || "").trim();
      const awbPending = !waybill && result?.bookingStatus === "BOOKED_AWB_PENDING";
      if ((!waybill && !awbPending) || waybill.length > 100) return res.status(502).json({ success: false, code: "BOOKING_OUTCOME_UNCONFIRMED", message: "The courier response did not confirm a booking and AWB state. Reconcile before any further action.", bookingStatusPath: "/shipments/drafts/" + row._id + "/booking-status" });

      const record = buildBookedRecord({ data: bookingData, quote, waybill: waybill || "", reference, bookingStatus: awbPending ? "BOOKED_AWB_PENDING" : "AWB_GENERATED", providerRecord: result.record, finalPartnerCostSnapshot: result.finalPartnerCostSnapshot });
      const receipt = result.receipt || (awbPending ? { success: true, status: "BOOKED_AWB_PENDING" } : { success: true, packages: [{ waybill, status: "Success" }] });
      let saved;
      try {
        saved = await Shipment.findOneAndUpdate(
          { _id: row._id, owner: req.user.id, state: "creating", kind: "forward", reference },
          { $set: { state: "saved", waybill: waybill || undefined, record, receipt, "draftData.bookingAttempt.status": awbPending ? "BOOKED_AWB_PENDING" : "AWB_GENERATED", "draftData.bookingCompletedAt": new Date().toISOString() } },
          { new: true, runValidators: true }
        ).lean();
      } catch {
        return res.status(503).json({ success: false, code: "BOOKING_SAVE_FAILED", waybill, message: "The courier returned AWB " + waybill + ", but saving the shipment failed. Do not submit it again." });
      }
      if (!saved) return res.status(503).json({ success: false, code: "BOOKING_SAVE_FAILED", waybill, message: "The courier returned AWB " + waybill + ", but the saved shipment could not be confirmed. Do not submit it again." });
      return res.status(201).json({ success: true, data: receipt, shipment: record });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ success: false, message: "This order reference is already reserved." });
      return res.status(503).json({ success: false, message: "Shipment booking could not be completed." });
    }
  });

  router.post("/shipments/drafts/:id/reconcile", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid booking ID." });
    try {
      const row = await Shipment.findOne({ _id: req.params.id, owner: req.user.id, kind: "forward", state: { $in: ["creating", "saved"] } }).lean();
      if (!row) return res.status(404).json({ success: false, message: "Booking attempt not found." });
      if (row.state === "saved" && row.waybill) return res.json({ success: true, data: { status: "AWB_GENERATED", waybill: row.waybill, retryAllowed: false } });
      const attempt = row.draftData?.bookingAttempt || {};
      const draftData = row.draftData || {};
      const selectedQuote = draftData.selectedPartnerQuote || (draftData.partnerQuoteBatches || []).flatMap(batch => batch.quotes || []).find(quote => quote.id === attempt.quoteId) || {};
      const adapter = getReconciliationAdapter(attempt.partnerCode);
      if (!adapter || typeof adapter.reconcile !== "function") return res.status(409).json({ success: false, code: "RECONCILIATION_UNAVAILABLE", message: "The selected courier has no safe reconciliation adapter." });
      if (attempt.partnerCode === "DELHIVERY" && !attempt.providerReference) {
        return res.status(409).json({ success: false, code: "RECONCILIATION_UNAVAILABLE", message: "This older booking has no attempt-specific carrier reference. Verify it with Delhivery before resubmitting." });
      }
      const reconcileInput = Object.freeze({ idempotencyKey: attempt.idempotencyKey, reference: row.draftData?.formData?.reference || row.reference, quoteId: attempt.quoteId, ...(attempt.providerReference && { providerReference: attempt.providerReference }) });
      const outcome = await singleFlight(`booking-reconcile:${req.user.id}:${row._id}:${attempt.idempotencyKey || "missing"}`, () => withSafeReadRetry(
        () => adapter.reconcile(reconcileInput),
        { policy: "bookingReconciliation" }
      ));
      if (!outcome || !["BOOKED", "NOT_FOUND_FINAL", "PENDING", "UNKNOWN"].includes(outcome.status)) return res.status(502).json({ success: false, code: "RECONCILIATION_UNCONFIRMED", message: "The courier returned no conclusive reconciliation result." });
      if (outcome.status === "NOT_FOUND_FINAL" && row.state === "creating" && attempt.partnerCode !== "DELHIVERY") {
        const reset = await Shipment.findOneAndUpdate({ _id: row._id, owner: req.user.id, state: "creating", updatedAt: row.updatedAt }, { $set: { state: "draft", reference: `DRAFT-${row._id}`, "draftData.bookingAttempt.status": "BOOKING_NOT_FOUND_FINAL", "draftData.bookingAttempt.reconciledAt": new Date().toISOString() } }, { new: true, runValidators: true }).lean();
        return reset ? res.json({ success: true, data: { status: "BOOKING_NOT_FOUND_FINAL", retryAllowed: true } }) : res.status(409).json({ success: false, message: "Booking attempt changed during reconciliation." });
      }
      if (outcome.status === "BOOKED") {
        if (!outcome.waybill) {
          if (row.state === "creating") {
            const record = buildBookedRecord({ data: draftData, quote: selectedQuote, reference: draftData.formData?.reference || row.reference, bookingStatus: "BOOKED_AWB_PENDING", providerRecord: row.record });
            await Shipment.findOneAndUpdate({ _id: row._id, owner: req.user.id, state: "creating", updatedAt: row.updatedAt }, { $set: { state: "saved", record, receipt: outcome.receipt || null, "draftData.bookingAttempt.status": "BOOKED_AWB_PENDING", "draftData.bookingAttempt.reconciledAt": new Date().toISOString() } }, { new: true, runValidators: true }).lean();
          }
          return res.status(202).json({ success: true, data: { status: "BOOKED_AWB_PENDING", retryAllowed: false } });
        }
        const waybill = String(outcome.waybill);
        if (attempt.partnerCode === "DELHIVERY") {
          const existing = await Shipment.findOne({ waybill, state: "saved" }).lean();
          if (existing && String(existing._id) !== String(row._id)) {
            return res.status(409).json({ success: false, code: "RECONCILIATION_UNCONFIRMED", message: "The returned waybill could not be assigned safely. Verify it with Delhivery before resubmitting." });
          }
        }
        const record = buildBookedRecord({ data: draftData, quote: selectedQuote, waybill, reference: draftData.formData?.reference || row.reference, bookingStatus: "AWB_GENERATED", providerRecord: row.record });
        const saved = await Shipment.findOneAndUpdate({ _id: row._id, owner: req.user.id, state: row.state, updatedAt: row.updatedAt }, { $set: { state: "saved", waybill, record, receipt: outcome.receipt || row.receipt, "draftData.bookingAttempt.status": "AWB_GENERATED", "draftData.bookingAttempt.reconciledAt": new Date().toISOString() } }, { new: true, runValidators: true }).lean();
        return saved ? res.json({ success: true, data: { status: "AWB_GENERATED", waybill, retryAllowed: false } }) : res.status(409).json({ success: false, message: "Booking attempt changed during reconciliation." });
      }
      await Shipment.findOneAndUpdate({ _id: row._id, owner: req.user.id, state: row.state, updatedAt: row.updatedAt }, { $set: { "draftData.bookingAttempt.status": outcome.status === "PENDING" ? "BOOKING_PENDING" : "OUTCOME_UNCONFIRMED", "draftData.bookingAttempt.reconciledAt": new Date().toISOString() } }, { new: true, runValidators: true });
      return res.json({ success: true, data: { status: outcome.status === "PENDING" ? "BOOKING_PENDING" : "OUTCOME_UNCONFIRMED", retryAllowed: false } });
    } catch { return res.status(503).json({ success: false, code: "RECONCILIATION_UNCONFIRMED", message: "Booking reconciliation could not be completed safely." }); }
  });

  router.post("/shipments/drafts/:id/quotes/:quoteId/select", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid draft ID." });
    try {
      const row = await Shipment.findOne({ _id: req.params.id, owner: req.user.id, state: "draft", kind: "forward" }).lean();
      if (!row) return res.status(404).json({ success: false, message: "Draft not found." });
      const batches = row.draftData?.partnerQuoteBatches || [];
      const activeBatchId = row.draftData?.activePartnerQuoteBatchId;
      const batch = batches.find(item => item.id === activeBatchId && !item.archived);
      const quote = batch?.quotes?.find(item => item.id === req.params.quoteId);
      if (!quote) return res.status(404).json({ success: false, message: "Quotation not found for this draft." });
      if (!isFreshQuoteBatch(batch, row.draftData || {}, row._id)) return res.status(409).json({ success: false, code: "QUOTE_STALE", message: "Shipment inputs changed after quotation. Request fresh quotations before selecting." });
      const selectedMode = batch.compareModes === true ? { SURFACE: "Surface", EXPRESS: "Express" }[quote.mode] : null;
      const selectedData = selectedMode ? { ...row.draftData, formData: { ...row.draftData.formData, mode: selectedMode } } : row.draftData;
      const quoteError = validateSelectedQuote(quote, batch, selectedData || {}, row._id);
      if (quoteError) return res.status(409).json({ success: false, ...quoteError });
      const updated = await Shipment.findOneAndUpdate(
        { _id: row._id, owner: req.user.id, state: "draft", kind: "forward", updatedAt: row.updatedAt, "draftData.activePartnerQuoteBatchId": activeBatchId },
        { $set: { "draftData.selectedPartnerQuote": quote, ...(selectedMode && { "draftData.formData.mode": selectedMode }) } },
        { new: true, runValidators: true }
      ).lean();
      if (!updated) return res.status(404).json({ success: false, message: "Draft not found." });
      return res.json({ success: true, data: { selectedPartnerQuote: quote, ...(selectedMode && { selectedMode }) } });
    } catch {
      return res.status(503).json({ success: false, message: "Courier selection could not be saved." });
    }
  });
  return router;
};
module.exports.summarizeQuotePartnerPerformance = summarizeQuotePartnerPerformance;
