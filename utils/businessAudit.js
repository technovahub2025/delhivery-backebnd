const SENSITIVE_FIELD = /password|token|secret|authorization|credential|payment|email|phone|address|gst|payload|body|uri|cookie/i;

const EVENT_MAP = [
  ["POST", /^\/api\/delhivery\/waybills\/?$/, () => ({ action: "waybill.allocation_attempted", entityType: "WAYBILL" })],
  ["POST", /^\/api\/customers\/?$/, req => ({ action: "customer.created", entityType: "CUSTOMER", changedFields: safeFieldNames(req.body, ["category", "companyName", "displayName", "rateCardId", "creditLimit"]) })],
  ["PATCH", /^\/api\/customers\/[^/]+\/?$/, req => ({ action: Object.hasOwn(req.body || {}, "rateCardId") ? "customer.rate_card_assigned" : "customer.updated", entityType: "CUSTOMER", changedFields: safeFieldNames(req.body, ["category", "companyName", "displayName", "rateCardId", "creditLimit"]) })],
  ["POST", /^\/api\/rate-cards\/?$/, () => ({ action: "rate_card.created", entityType: "RATE_CARD" })],
  ["PATCH", /^\/api\/rate-cards\/[^/]+\/?$/, () => ({ action: "rate_card.updated", entityType: "RATE_CARD" })],
  ["POST", /^\/api\/rate-cards\/[^/]+\/versions\/?$/, () => ({ action: "rate_card.version_created", entityType: "RATE_CARD" })],
  ["POST", /^\/api\/delhivery\/shipments\/drafts\/?$/, () => ({ action: "shipment_draft.created", entityType: "SHIPMENT_DRAFT" })],
  ["PATCH", /^\/api\/delhivery\/shipments\/drafts\/[^/]+\/?$/, () => ({ action: "shipment_draft.updated", entityType: "SHIPMENT_DRAFT" })],
  ["POST", /^\/api\/delhivery\/shipments\/drafts\/[^/]+\/quotes\/[^/]+\/select\/?$/, () => ({ action: "booking.quote_selected", entityType: "SHIPMENT_DRAFT" })],
  ["POST", /^\/api\/delhivery\/shipments\/drafts\/[^/]+\/book\/?$/, () => ({ action: "booking.attempted", entityType: "SHIPMENT_DRAFT" })],
  ["POST", /^\/api\/delhivery\/shipments\/drafts\/[^/]+\/reconcile\/?$/, () => ({ action: "booking.reconciled", entityType: "SHIPMENT_DRAFT" })],
  ["POST", /^\/api\/delhivery\/shipments\/?$/, () => ({ action: "shipment.booking_attempted", entityType: "SHIPMENT" })],
  ["POST", /^\/api\/delhivery\/pickup-requests\/?$/, () => ({ action: "pickup.created", entityType: "PICKUP_REQUEST" })],
  ["PATCH", /^\/api\/delhivery\/pickup-requests\/[^/]+\/?$/, req => ({ action: req.body?.pickupDate || req.body?.pickupTime ? "pickup.rescheduled" : "pickup.updated", entityType: "PICKUP_REQUEST", changedFields: safeFieldNames(req.body, ["pickupDate", "pickupTime", "packageCount", "totalWeightKg"]) })],
  ["POST", /^\/api\/delhivery\/pickup-requests\/[^/]+\/cancel\/?$/, () => ({ action: "pickup.cancelled", entityType: "PICKUP_REQUEST" })],
  ["DELETE", /^\/api\/delhivery\/pickup-requests\/[^/]+\/?$/, () => ({ action: "pickup.cancelled", entityType: "PICKUP_REQUEST" })],
  ["POST", /^\/api\/delhivery\/pickup-requests\/[^/]+\/status\/?$/, () => ({ action: "pickup.lifecycle_changed", entityType: "PICKUP_REQUEST" })],
  ["POST", /^\/api\/delhivery\/pickups\/?$/, () => ({ action: "pickup.carrier_booking_attempted", entityType: "PICKUP_REQUEST" })],
  ["POST", /^\/api\/delhivery\/shipments\/[^/]+\/tracking\/sync\/?$/, () => ({ action: "tracking.synchronized", entityType: "SHIPMENT" })],
  ["POST", /^\/api\/delhivery\/ndr\/cases\/process\/?$/, () => ({ action: "ndr.observations_processed", entityType: "NDR_CASE" })],
  ["POST", /^\/api\/delhivery\/ndr\/cases\/[^/]+\/actions\/?$/, () => ({ action: "ndr.action_submitted", entityType: "NDR_CASE" })],
  ["POST", /^\/api\/delhivery\/ndr\/update\/?$/, () => ({ action: "ndr.action_submitted", entityType: "NDR_CASE" })],
  ["POST", /^\/api\/delhivery\/rto\/cases\/process\/?$/, () => ({ action: "rto.observations_processed", entityType: "RTO_CASE" })],
  ["POST", /^\/api\/delhivery\/rto\/cases\/[^/]+\/return-shipment\/?$/, () => ({ action: "rto.return_shipment_linked", entityType: "RTO_CASE" })],
  ["POST", /^\/api\/delhivery\/rto\/cases\/[^/]+\/sync\/?$/, () => ({ action: "rto.status_synchronized", entityType: "RTO_CASE" })],
  ["POST", /^\/api\/billing\/walk-in-payments\/[^/]+\/?$/, () => ({ action: "payment.walk_in_receipt_created", entityType: "SHIPMENT" })],
  ["POST", /^\/api\/billing\/payments\/?$/, () => ({ action: "payment.allocated", entityType: "PAYMENT" })],
  ["POST", /^\/api\/billing\/invoices\/[^/]+\/adjustments\/?$/, () => ({ action: "invoice.adjusted", entityType: "INVOICE" })],
  ["POST", /^\/api\/billing\/invoices\/?$/, () => ({ action: "invoice.generated", entityType: "INVOICE" })],
];

function safeFieldNames(body, allowed) {
  return Object.keys(body || {}).filter(key => allowed.includes(key) && !SENSITIVE_FIELD.test(key)).sort();
}

function requestPath(req) {
  try { return new URL(req.originalUrl || req.url || "/", "http://local").pathname; }
  catch { return "/"; }
}

function pathEntityRef(path) {
  const patterns = [
    /^\/api\/customers\/([A-Za-z0-9_-]{1,100})(?:\/|$)/,
    /^\/api\/rate-cards\/([A-Za-z0-9_-]{1,100})(?:\/|$)/,
    /^\/api\/delhivery\/shipments\/drafts\/([A-Za-z0-9_-]{1,100})(?:\/|$)/,
    /^\/api\/delhivery\/pickup-requests\/([A-Za-z0-9_-]{1,100})(?:\/|$)/,
    /^\/api\/delhivery\/shipments\/([A-Za-z0-9_-]{1,100})\/tracking\/sync\/?$/,
    /^\/api\/delhivery\/ndr\/cases\/([A-Za-z0-9_-]{1,100})(?:\/|$)/,
    /^\/api\/delhivery\/rto\/cases\/([A-Za-z0-9_-]{1,100})(?:\/|$)/,
  ];
  for (const pattern of patterns) {
    const reference = pattern.exec(path)?.[1];
    if (reference) return reference;
  }
  return null;
}

function auditSpec(req) {
  const method = String(req.method || "GET").toUpperCase();
  const path = requestPath(req);
  const entry = EVENT_MAP.find(([verb, pattern]) => verb === method && pattern.test(path));
  if (!entry) return null;
  const [, , build] = entry;
  return { ...build(req), entityRef: req.params?.id || req.params?.shipmentId || pathEntityRef(path) };
}

function responseEntityRef(body, fallback) {
  const data = body?.data;
  if (!data || typeof data !== "object") return fallback;
  for (const key of ["customer", "rateCard", "draft", "shipment", "pickup", "case", "ndr", "rto", "cost"]) {
    const id = data[key]?.id || data[key]?._id;
    if (typeof id === "string" && id.length <= 160) return id;
  }
  return fallback;
}

function providerReference(body) {
  const data = body?.data;
  const candidates = [data?.pickup?.carrierRequestId, data?.pickup?.providerRequestId, data?.action?.providerRequestId, data?.providerRequestId];
  return candidates.find(value => typeof value === "string" && value.length <= 100 && /^[A-Za-z0-9._:-]+$/.test(value)) || null;
}

function auditIdempotencyKey(req, spec) {
  if (!spec?.action?.startsWith("payment.") && !["invoice.adjusted", "invoice.generated"].includes(spec?.action)) return null;
  const body = req.body || {};
  const value = body.idempotencyKey || body.invoiceNumber || req.params?.shipmentId || req.params?.id;
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 160) : null;
}

function auditOutcome(status, body) {
  if (status >= 200 && status < 400) return "SUCCEEDED";
  if (["BOOKING_OUTCOME_UNCONFIRMED", "BOOKING_SAVE_FAILED", "RECONCILIATION_UNCONFIRMED", "OUTCOME_UNCONFIRMED", "NDR_ACTION_OUTCOME_UNCONFIRMED"].includes(body?.code)) return "UNCONFIRMED";
  return "FAILED";
}

function retentionExpiry(daysValue, now = new Date()) {
  const raw = String(daysValue ?? "").trim();
  if (!/^(?:[1-9]\d{0,3})$/.test(raw)) return undefined;
  const days = Number(raw);
  if (days < 1 || days > 3650 || !(now instanceof Date) || !Number.isFinite(now.getTime())) return undefined;
  return new Date(now.getTime() + days * 86400000);
}

function createBusinessAuditMiddleware({ AuditModel, onError = () => {}, getRetentionDays = () => process.env.BUSINESS_AUDIT_RETENTION_DAYS, now = () => new Date() }) {
  return function businessAudit(req, res, next) {
    const spec = auditSpec(req);
    if (!spec) return next();
    const sendJson = res.json.bind(res);
    let recorded = false;
    res.json = function auditedJson(body) {
      const ownerId = req.user?.id;
      const statusCode = res.statusCode || 200;
      const bookingTransition = spec.action.startsWith("booking.") && ["BOOKING_REJECTED", "BOOKING_OUTCOME_UNCONFIRMED", "BOOKING_SAVE_FAILED", "RECONCILIATION_UNCONFIRMED"].includes(body?.code);
      const ndrTransition = spec.action === "ndr.action_submitted" && ["NDR_ACTION_UNAVAILABLE", "ACTION_FAILED", "OUTCOME_UNCONFIRMED", "NDR_ACTION_OUTCOME_UNCONFIRMED"].includes(body?.code);
      const financeTransition = spec.action.startsWith("payment.") || spec.action === "invoice.adjusted" || spec.action === "invoice.generated";
      const mutated = statusCode >= 200 && statusCode < 400 || bookingTransition || ndrTransition || (financeTransition && statusCode >= 400 && statusCode < 500);
      if (!recorded && !res.locals.skipBusinessAudit && mutated && ownerId && AuditModel?.create) {
        recorded = true;
        const event = {
          ownerId: String(ownerId), actorId: String(ownerId), action: spec.action, entityType: spec.entityType,
          entityRef: responseEntityRef(body, spec.entityRef), outcome: auditOutcome(statusCode, body), statusCode,
          changedFields: spec.changedFields || [], correlationId: req.correlationId || null,
        };
        const idempotencyKey = auditIdempotencyKey(req, spec);
        if (idempotencyKey) event.idempotencyKey = idempotencyKey;
        const expiresAt = retentionExpiry(getRetentionDays(), now());
        if (expiresAt) event.expiresAt = expiresAt;
        res.locals.businessReferenceId = event.entityRef;
        const providerRef = providerReference(body);
        if (providerRef) res.locals.providerReferenceId = providerRef;
        return Promise.resolve().then(() => AuditModel.create(event)).catch(error => { try { onError(error); } catch { /* audit failures never affect the business response */ } }).then(() => sendJson(body));
      }
      return sendJson(body);
    };
    return next();
  };
}

module.exports = { createBusinessAuditMiddleware, auditSpec, safeFieldNames, responseEntityRef, auditOutcome, providerReference, pathEntityRef, retentionExpiry, auditIdempotencyKey };
