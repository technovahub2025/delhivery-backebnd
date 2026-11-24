function responseValue(response) {
  let value = response?.data;
  if (value && typeof value === "object" && value.data !== undefined) value = value.data;
  if (Array.isArray(value)) value = value[0];
  return value;
}

function assertCarrierAccepted(value) {
  if (!value || typeof value !== "object" || value.success === false || value.status === false || /^(fail|failed|failure|error)$/i.test(String(value.status || "")) || (value.error && value.error !== "false") || (value.errors && Object.keys(value.errors).length)) {
    const error = new Error("Courier definitively rejected the request.");
    error.definitive = true;
    error.outcome = "REJECTED";
    throw error;
  }
}

function classifyBookingResponse(value, parcel, envelope = value) {
  const candidate = parcel?.waybill || parcel?.wbn || parcel?.AWB;
  const waybill = (typeof candidate === "string" || Number.isSafeInteger(candidate)) && /^[a-z\d-]{1,100}$/i.test(String(candidate)) ? String(candidate) : "";
  const clearlyRejected = [envelope, value, parcel].some(item => item?.success === false || item?.status === false ||
    /^(fail|failed|failure|error)$/i.test(String(item?.status || "")));
  const hasErrorDetails = [envelope, value, parcel].some(item => (item?.error && item.error !== "false") ||
    (item?.errors && Object.keys(item.errors).length));
  const uncertain = /partially\s+saved|might\s+have\s+been|may\s+have\s+been|internal\s+error|crashing\s+while\s+saving|timeout|timed\s+out|already\s+(?:exists|booked|created)|duplicate/i.test(JSON.stringify(envelope) || "");
  if (waybill && !clearlyRejected && !hasErrorDetails && !uncertain) return { waybill, outcome: "CONFIRMED" };
  return { waybill, outcome: !candidate && clearlyRejected && !uncertain ? "REJECTED" : "AMBIGUOUS" };
}

function findPickupId(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return "";
  const direct = value.pickup_id || value.request_id || value.pickup_request_id || value.id;
  if ((typeof direct === "string" || Number.isSafeInteger(direct)) && /^[a-z\d_-]{1,100}$/i.test(String(direct))) return String(direct);
  return findPickupId(value.data, depth + 1);
}

const { isDelhiveryFeatureEnabled } = require("../utils/delhiveryFeatureFlags");
const { safeProviderSnapshot } = require("../utils/delhiveryError");

function classifyTrackingTimestamp(value) {
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (type === "number" && Number.isFinite(value)) return { type, category: "epoch", timezonePresent: false };
  if (type !== "string") return { type, category: "unsupported", timezonePresent: false };
  const text = value.trim();
  const timezonePresent = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return { type, category: "ISO", timezonePresent };
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) return { type, category: "date-time without timezone", timezonePresent };
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return { type, category: "invalid", timezonePresent };
  return { type, category: "unsupported", timezonePresent };
}

function trackingEvent(detail, { scan = false, statusCode = "", utcOffset, diagnostics, fieldName } = {}) {
  const status = scan ? detail?.Scan || detail?.Instructions : detail?.Status;
  let occurredAt = scan ? detail?.ScanDateTime || detail?.StatusDateTime : detail?.StatusDateTime;
  const timestampInfo = classifyTrackingTimestamp(occurredAt);
  const reject = reason => { if (diagnostics) diagnostics.timestampDiagnostics.push({ field: fieldName, ...timestampInfo, rejectionReason: reason }); return null; };
  if (typeof status !== "string" || !status.trim()) return reject("missing status");
  if (typeof occurredAt !== "string" || !occurredAt.trim()) return reject("missing timestamp");
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(occurredAt)) {
    if (!/^[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00)$/.test(utcOffset || "")) return reject("timezone offset required");
    occurredAt = occurredAt.replace(" ", "T") + utcOffset;
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(occurredAt)) return reject("timezone missing");
  if (!Number.isFinite(Date.parse(occurredAt))) return reject("invalid date");
  return {
    status: safeProviderSnapshot(status),
    occurredAt,
    location: safeProviderSnapshot(String((scan ? detail.ScannedLocation : detail.StatusLocation) || "")),
    description: safeProviderSnapshot(String(detail.Instructions || "")),
    statusCode: safeProviderSnapshot(String(detail.StatusCode || statusCode)),
    statusType: safeProviderSnapshot(String((scan ? detail.ScanType : detail.StatusType) || "")),
  };
}

function safeTrackingDiagnostics(diagnostics) {
  return {
    responseShape: diagnostics.responseShape,
    httpStatus: Number.isInteger(diagnostics.httpStatus) ? diagnostics.httpStatus : undefined,
    rowCount: diagnostics.rowCount,
    awbMatchCount: diagnostics.awbMatchCount,
    validEventCount: diagnostics.validEventCount,
    timestampRejectedCount: diagnostics.timestampRejectedCount,
    timestampDiagnostics: diagnostics.timestampDiagnostics.slice(0, 20),
  };
}

async function getPincodeServiceability(carrier, pincode) {
  const response = await carrier.get("/c/api/pin-codes/json/", { params: { filter_codes: String(pincode) }, timeout: 10000 });
  if (!Array.isArray(response?.data?.delivery_codes) ||
      response.data.delivery_codes.some(entry => !entry?.postal_code || typeof entry.postal_code !== "object")) {
    throw Object.assign(new Error("Courier serviceability could not be confirmed."), { code: "DELHIVERY_PINCODE_INVALID_RESPONSE" });
  }
  const delivery_codes = response.data.delivery_codes.filter(entry => {
    const code = entry?.postal_code;
    return code && (code.pin == null || String(code.pin) === String(pincode));
  });
  return { delivery_codes };
}

function isPostalCodeServiceable(code, paymentField) {
  return String(code.remarks || "").trim().toLowerCase() !== "embargo" &&
    code[paymentField] === "Y";
}

function createDelhiveryCourierAdapter(carrier, { getEnvironment = () => process.env } = {}) {
  if (!carrier || typeof carrier.get !== "function" || typeof carrier.post !== "function") throw new TypeError("A Delhivery-compatible carrier client is required.");
  const assertEnabled = (feature) => {
    if (!isDelhiveryFeatureEnabled(feature, getEnvironment())) {
      const error = new Error(`Delhivery ${feature} feature is disabled.`);
      error.code = "DELHIVERY_FEATURE_DISABLED";
      error.status = 503;
      throw error;
    }
  };
  const postMutation = async (path, payload, feature, hooks = {}) => {
    assertEnabled(feature);
    const dispatchStartedAt = new Date();
    await hooks.onDispatchStarted?.(dispatchStartedAt);
    let response;
    try { response = await carrier.post(path, payload, { headers: { "Content-Type": "application/json" } }); }
    catch (error) { error.outcome = "AMBIGUOUS"; error.dispatchStartedAt = dispatchStartedAt; await hooks.onTransportError?.(error, dispatchStartedAt); throw error; }
    const body = response?.data;
    await hooks.onProviderResponse?.({ status: response?.status, receivedAt: new Date(), body });
    try { assertCarrierAccepted(body); }
    catch (error) {
      error.responseSnapshot = body;
      if (classifyBookingResponse(body).outcome !== "REJECTED") { error.definitive = false; error.outcome = "AMBIGUOUS"; }
      await hooks.onProviderError?.(error, { status: response?.status, receivedAt: new Date(), body });
      throw error;
    }
    return { responseSnapshot: body, providerHttpStatus: response?.status };
  };
  const editShipment = async (payload, feature) => {
    const { responseSnapshot } = await postMutation("/api/p/edit", payload, feature);
    const result = responseValue({ data: responseSnapshot });
    if (result?.status !== true && result?.success !== true) {
      const error = new Error("The carrier did not confirm the shipment change.");
      error.outcome = "AMBIGUOUS";
      throw error;
    }
    return { responseSnapshot: safeProviderSnapshot(responseSnapshot) };
  };
  return Object.freeze({
    code: "DELHIVERY",
    name: "Delhivery",
    async checkServiceability({ pincode, paymentType }) {
      const paymentField = String(paymentType || "").toUpperCase() === "COD" ? "cod" : "pre_paid";
      if (!/^\d{6}$/.test(String(pincode || "")) || !/^(COD|PRE-?PAID)$/i.test(String(paymentType || ""))) return false;
      assertEnabled("PINCODE_SERVICEABILITY");
      const { delivery_codes } = await getPincodeServiceability(carrier, pincode);
      return delivery_codes.some(entry => isPostalCodeServiceable(entry.postal_code, paymentField));
    },
    async quote(context) {
      const input = context.partnerInput || {};
      if (!/^\d{6}$/.test(input.originPincode) || !/^\d{6}$/.test(input.destinationPincode) || !Number.isFinite(input.chargeableWeightKg) || input.chargeableWeightKg <= 0) throw new Error("Valid origin, destination and chargeable weight are required for this quotation.");
      const mode = String(input.mode || "").toUpperCase();
      const md = mode === "SURFACE" ? "S" : mode === "EXPRESS" ? "E" : null;
      if (!md) throw new Error("Select a supported shipment mode before requesting this quotation.");
      assertEnabled("SHIPPING_COST");
      const response = await carrier.get("/api/kinko/v1/invoice/charges/.json", { timeout: 10000, params: {
        md, ss: "Delivered", d_pin: input.destinationPincode, o_pin: input.originPincode,
        cgm: Math.round(input.chargeableWeightKg * 1000), pt: input.paymentType === "COD" ? "COD" : "Pre-paid",
      } });
      const value = responseValue(response);
      try { assertCarrierAccepted(value); }
      catch (error) { error.providerResponseSnapshot = value; throw error; }
      const rawAmount = value?.total_amount;
      const amount = typeof rawAmount === "number" || (typeof rawAmount === "string" && rawAmount.trim() !== "") ? Number(rawAmount) : NaN;
      if (!Number.isFinite(amount) || amount <= 0) {
        const error = new Error("Delhivery returned no valid quotation amount.");
        error.code = "INVALID_PROVIDER_QUOTE";
        error.providerResponseSnapshot = value;
        throw error;
      }
      return { serviceCode: md, serviceName: mode === "SURFACE" ? "Surface" : "Express", mode, amount, currency: value.currency || "INR", provenance: "PROVIDER_ESTIMATE", estimateSnapshot: safeProviderSnapshot(value) };
    },
    async track(context) {
      assertEnabled("TRACKING");
      const utcOffset = getEnvironment().DELHIVERY_TRACKING_UTC_OFFSET;
      const response = await carrier.get("/api/v1/packages/json/", { timeout: 10000, params: { waybill: context.waybill || "", ref_ids: context.waybill ? "" : context.reference || "" } });
      let value = response?.data;
      const diagnostics = { responseShape: Array.isArray(value) ? "array" : value && typeof value === "object" ? "object" : typeof value, httpStatus: response?.status, rowCount: 0, awbMatchCount: 0, validEventCount: 0, timestampRejectedCount: 0, timestampDiagnostics: [] };
      const invalid = () => Object.assign(new Error("The carrier returned an invalid or mismatched tracking response."), { code: "INVALID_TRACKING_RESPONSE", trackingDiagnostics: safeTrackingDiagnostics(diagnostics) });
      if (value?.success === false || value?.error) throw invalid();
      if (value && typeof value === "object" && value.data !== undefined) value = value.data;
      if (Array.isArray(value?.ShipmentData)) value = value.ShipmentData;
      if (!Array.isArray(value)) throw invalid();
      diagnostics.responseShape = "ShipmentData[]";
      diagnostics.rowCount = value.length;
      const events = [];
      for (const entry of value) {
        const shipment = entry?.Shipment || entry;
        if (context.waybill && String(shipment?.AWB || "") !== String(context.waybill)) continue;
        if (!context.waybill && context.reference && String(shipment?.ReferenceNo || "") !== String(context.reference)) continue;
        diagnostics.awbMatchCount += 1;
        const status = trackingEvent(shipment?.Status, { statusCode: shipment?.NSLCode, utcOffset, diagnostics, fieldName: "Shipment.Status.StatusDateTime" });
        if (status) { events.push(status); diagnostics.validEventCount += 1; }
        else if (shipment?.Status) diagnostics.timestampRejectedCount += 1;
        const scans = Array.isArray(shipment?.Scans) ? shipment.Scans : [];
        for (const scan of scans) {
          const event = trackingEvent(scan?.ScanDetail, { scan: true, utcOffset, diagnostics, fieldName: "Shipment.Scans[].ScanDetail.ScanDateTime" });
          if (event) { events.push(event); diagnostics.validEventCount += 1; }
          else if (scan?.ScanDetail) diagnostics.timestampRejectedCount += 1;
        }
      }
      if (value.length && !events.length) throw invalid();
      return { events };
    },
    async reconcile({ providerReference }) {
      // Only references generated and reserved by this application are safe on a shared carrier account.
      if (!/^CMS-[a-f0-9]{32}$/.test(providerReference || "")) return { status: "UNKNOWN" };
      assertEnabled("TRACKING");
      const response = await carrier.get("/api/v1/packages/json/", { params: { waybill: "", ref_ids: providerReference } });
      if (response.data?.success === false) return { status: "UNKNOWN" };
      const rows = response.data?.ShipmentData;
      if (!Array.isArray(rows) || rows.length !== 1) return { status: "UNKNOWN" };
      const shipment = rows[0]?.Shipment;
      const waybill = typeof shipment?.AWB === "string" || Number.isSafeInteger(shipment?.AWB) ? String(shipment.AWB) : "";
      if (shipment?.ReferenceNo !== providerReference || !/^\d{6,20}$/.test(waybill)) return { status: "UNKNOWN" };
      return { status: "BOOKED", waybill, receipt: { source: "TRACKING_RECONCILIATION", providerReference, waybill } };
    },
    normalizeWebhook(payload) {
      const shipment = payload?.Shipment;
      const event = trackingEvent(shipment?.Status, { statusCode: shipment?.NSLCode, utcOffset: getEnvironment().DELHIVERY_TRACKING_UTC_OFFSET });
      const waybill = ["string", "number"].includes(typeof shipment?.AWB) ? String(shipment.AWB) : "";
      return { waybill, reference: String(shipment?.ReferenceNo || ""), events: event ? [event] : [] };
    },
    async ndrAction(context) {
      const action = String(context.action || "").trim().toUpperCase();
      if (!["RE-ATTEMPT", "PICKUP_RESCHEDULE"].includes(action)) throw new Error("This NDR action is not supported by Delhivery.");
      const { responseSnapshot: body } = await postMutation("/api/p/update", { data: [{ waybill: context.waybill, act: action }] }, "NDR_OPERATIONS");
      let providerRequestId = "";
      const findRequestId = (value, depth = 0) => {
        if (!value || typeof value !== "object" || depth > 8) return "";
        for (const [key, item] of Object.entries(value)) if (/^(upl.?id|request.?id)$/i.test(key) && typeof item === "string" && /^UPL[A-Za-z0-9_-]{1,100}$/.test(item)) return item;
        for (const item of Object.values(value)) { const found = findRequestId(item, depth + 1); if (found) return found; }
        return "";
      };
      providerRequestId = findRequestId(body);
      if (!providerRequestId) {
        const error = new Error("The carrier did not confirm the NDR upload ID.");
        error.outcome = "AMBIGUOUS";
        throw error;
      }
      return { submitted: true, providerRequestId, responseSnapshot: safeProviderSnapshot(body) };
    },
    async ndrStatus(context) {
      assertEnabled("NDR_STATUS");
      const response = await carrier.get(`/api/cmu/get_bulk_upl/${encodeURIComponent(context.uplId)}`, { params: { verbose: "true" } });
      assertCarrierAccepted(response?.data);
      return { responseSnapshot: safeProviderSnapshot(response?.data) };
    },
    async updateShipment(context) {
      const payload = { waybill: String(context.waybill || "") };
      for (const key of ["name", "add", "phone", "pin", "city"]) if (context[key] !== undefined) payload[key] = context[key];
      if (!payload.waybill) throw new Error("Waybill is required.");
      return editShipment(payload, "SHIPMENT_UPDATE");
    },
    async cancelShipment(context) {
      const waybill = String(context.waybill || "");
      if (!waybill) throw new Error("Waybill is required.");
      return editShipment({ waybill, cancellation: "true" }, "SHIPMENT_CANCELLATION");
    },
    async updateEwaybill(context) {
      const waybill = String(context.waybill || "");
      if (!waybill || typeof context.ewbn !== "string" || !context.ewbn.trim()) throw new Error("Waybill and e-waybill are required.");
      return editShipment({ waybill, ewbn: context.ewbn }, "EWAYBILL");
    },
    async createPickup(context) {
      const request = context.request;
      if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("A pickup request is required.");
      const result = await postMutation("/fm/request/new/", request, "PICKUP_CREATION", context);
      const carrierRequestId = findPickupId(result.responseSnapshot);
      if (!carrierRequestId) {
        const error = new Error("Courier did not return a pickup request ID.");
        error.outcome = "AMBIGUOUS";
        throw error;
      }
      return { ...result, carrierRequestId };
    },
    async book(context) {
      const data = context.draftSnapshot || {};
      const form = data.formData || {};
      const quote = context.selectedQuote || {};
      const mode = String(quote.mode || form.mode || "").toUpperCase();
      const shippingMode = mode === "SURFACE" ? "Surface" : mode === "EXPRESS" ? "Express" : form.mode;
      const payload = { shipments: [{
        name: form.customer || "", add: form.address || "", pin: form.pincode || "", city: form.destination || "", state: form.state || "", country: "India",
        phone: form.phone || "", email: form.email || "", order: context.providerReference || form.reference || "", payment_mode: form.payment || "Prepaid",
        total_amount: String(form.value || "0"), cod_amount: form.payment === "COD" ? String(form.value || "0") : "0",
        products_desc: form.description || "", quantity: String(form.quantity || "1"), weight: String(Math.round(Number(form.weight || form.actualWeightKg || 0) * 1000)),
        shipment_length: form.length || "", shipment_width: form.width || "", shipment_height: form.height || "", shipping_mode: shippingMode,
      }], pickup_location: { name: form.warehouse || "" } };
      assertEnabled("SHIPMENT_BOOKING");
      const response = await carrier.post("/api/cmu/create.json", `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`, { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      const value = responseValue(response);
      const parcel = value?.packages?.[0] || value;
      const { waybill, outcome } = classifyBookingResponse(value, parcel, response?.data);
      if (outcome !== "CONFIRMED") {
        const error = new Error(outcome === "REJECTED" ? "Courier definitively rejected booking." : "Courier did not confirm booking.");
        error.definitive = outcome === "REJECTED";
        error.outcome = outcome;
        throw error;
      }
      return { waybill: String(waybill), providerCode: "DELHIVERY", providerOutcome: "PROVIDER_CONFIRMED", receipt: safeProviderSnapshot(value), record: { customer: form.customer || "", address: form.address || "", destination: form.destination || "", state: form.state || "", pincode: String(form.pincode || ""), phone: String(form.phone || ""), email: form.email || "", payment: form.payment || "", value: Number(form.value) || 0, weight: Number(form.weight || form.actualWeightKg || 0), warehouse: form.warehouse || "", status: "Pending pickup", providerCode: "DELHIVERY", providerOutcome: "PROVIDER_CONFIRMED" } };
    },
  });
}

module.exports = { createDelhiveryCourierAdapter, classifyBookingResponse, getPincodeServiceability, isPostalCodeServiceable };
