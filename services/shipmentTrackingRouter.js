const crypto = require("node:crypto");
const express = require("express");
const requireSession = require("../utils/requireSession");
const { withSafeReadRetry, singleFlight } = require("../utils/safeReadRetry");
const { readDelhiveryConfiguration } = require("../utils/delhiveryConfiguration");
const { isDelhiveryFeatureEnabled } = require("../utils/delhiveryFeatureFlags");

class TrackingInputError extends Error {}

function normalizeEvents(providerCode, events, source = "SYNC", now = new Date()) {
  if (!Array.isArray(events)) throw new TrackingInputError("Tracking events must be an array.");
  return events.map((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TrackingInputError("Each tracking event must be an object.");
    const status = typeof event.status === "string" ? event.status.trim() : "";
    const occurredAt = new Date(event.occurredAt);
    if (!status || !event.occurredAt || !Number.isFinite(occurredAt.getTime())) throw new TrackingInputError("Each tracking event requires a status and valid occurredAt timestamp.");
    const location = event.location == null ? "" : String(event.location).trim();
    const description = event.description == null ? "" : String(event.description).trim();
    const providerEventId = event.providerEventId == null ? "" : String(event.providerEventId).trim();
    const canonical = JSON.stringify([providerCode, status, location, occurredAt.toISOString(), description]);
    const eventKey = providerEventId
      ? `${providerCode}:${providerEventId}`
      : `${providerCode}:sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
    const statusCode = typeof event.statusCode === "string" ? event.statusCode.trim().slice(0, 80) : "";
    const statusType = typeof event.statusType === "string" ? event.statusType.trim().slice(0, 80) : "";
    return { providerCode, ...(providerEventId && { providerEventId }), ...(statusCode && { statusCode }), ...(statusType && { statusType }), eventKey, status, location, occurredAt, description, source, receivedAt: now };
  });
}

function sortedEvents(events) {
  return [...events].sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt) || String(a.eventKey).localeCompare(String(b.eventKey)));
}

function findOwnedShipment(Shipment, owner, value, kind) {
  const clauses = kind === "waybill"
    ? [{ waybill: value }]
    : [{ reference: value }, { "record.reference": value }, { "record.order": value }, { "draftData.formData.reference": value }];
  return Shipment.findOne({ owner, state: "saved", $or: clauses });
}

function readQuery(query) { return query && typeof query.lean === "function" ? query.lean() : query; }

function shipmentView(row) {
  return { id: String(row._id), waybill: row.waybill || "", reference: row.reference || "", status: row.trackingStatus || "", statusAt: row.trackingStatusAt || null };
}

function trackingResponse(row) {
  const events = sortedEvents(Array.isArray(row.trackingEvents) ? row.trackingEvents : []);
  const latest = events.at(-1);
  // Retain the prior Delhivery-shaped ShipmentData envelope used by exception and reverse-order screens.
  const shipment = {
    AWB: row.waybill || "",
    Status: { Status: row.trackingStatus || latest?.status || "", StatusDateTime: row.trackingStatusAt || latest?.occurredAt || null, Instructions: latest?.description || "" },
    Scans: events.map(event => ({ ScanDetail: { Instructions: event.status, StatusDateTime: event.occurredAt } })),
  };
  return { shipment: shipmentView(row), events, ShipmentData: [{ Shipment: shipment }] };
}

async function appendTrackingEvents({ Shipment, shipment, providerCode, events, source, now = () => new Date() }) {
  const normalized = normalizeEvents(providerCode, events, source, now());
  if (!normalized.length) return shipment;
  // Revision-guarded writes prevent concurrent sync/webhook updates from replacing each other.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = attempt === 0 ? shipment : await readQuery(Shipment.findOne({ _id: shipment._id, owner: shipment.owner, state: "saved" }));
    if (!current) return null;
    const existing = Array.isArray(current.trackingEvents) ? current.trackingEvents : [];
    const keys = new Set(existing.map((event) => event.eventKey).filter(Boolean));
    const additions = normalized.filter((event) => {
      if (keys.has(event.eventKey)) return false;
      keys.add(event.eventKey);
      return true;
    });
    if (!additions.length) return current;
    const allEvents = sortedEvents([...existing, ...additions]);
    const newestExisting = current.trackingStatusAt ? new Date(current.trackingStatusAt) : null;
    const newestAdded = [...additions].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt) || String(a.eventKey).localeCompare(String(b.eventKey)))[0];
    const advancesStatus = !newestExisting || new Date(newestAdded.occurredAt) > newestExisting;
    const revision = Number(current.trackingRevision || 0);
    const revisionCondition = revision === 0
      ? { $or: [{ trackingRevision: 0 }, { trackingRevision: { $exists: false } }] }
      : { trackingRevision: revision };
    const result = await Shipment.updateOne(
      { _id: current._id, owner: current.owner, state: "saved", ...revisionCondition },
      { $set: { trackingEvents: allEvents, trackingRevision: revision + 1, ...(advancesStatus ? { trackingStatus: newestAdded.status, trackingStatusAt: newestAdded.occurredAt } : {}) } }
    );
    if (result.modifiedCount === 1 || result.nModified === 1) return readQuery(Shipment.findOne({ _id: current._id, owner: current.owner, state: "saved" }));
  }
  const error = new Error("Tracking history changed concurrently. Retry the operation.");
  error.status = 409;
  throw error;
}

async function synchronizeShipmentTracking({ Shipment, row, partnerRegistry, now, source = "SYNC", getEnvironment = () => process.env, logger = console }) {
  const code = String(row.record?.partnerCode || row.record?.carrierCode || row.draftData?.selectedPartnerQuote?.partnerCode || row.record?.providerCode || "").toUpperCase();
  if (code === "DELHIVERY" && row.record?.mockOnly === true) {
    const error = new Error("Mock-only shipments cannot use live Delhivery tracking."); error.code = "TRACKING_ADAPTER_UNAVAILABLE"; throw error;
  }
  if (code === "DELHIVERY" && !/^\d{6,20}$/.test(row.waybill || "")) {
    const error = new Error("A genuine numeric Delhivery AWB is required for tracking."); error.code = "INVALID_TRACKING_AWB"; throw error;
  }
  const environment = getEnvironment() || {};
  const trackingFeatureEnabled = code === "DELHIVERY" ? isDelhiveryFeatureEnabled("TRACKING", environment) : false;
  const delhiveryConfigurationPresent = code === "DELHIVERY" ? Boolean(readDelhiveryConfiguration(environment)) : false;
  const diagnostic = { event: "tracking.adapter_diagnostic", shipmentId: String(row._id), resolvedCourierCode: code, hasTrackingAdapter: false, trackingFeatureEnabled, delhiveryConfigurationPresent };
  try { logger?.info?.(JSON.stringify(diagnostic)); } catch { /* diagnostics must never affect tracking */ }
  const adapter = partnerRegistry?.get(code);
  diagnostic.hasTrackingAdapter = Boolean(adapter && typeof adapter.track === "function");
  if (!diagnostic.hasTrackingAdapter) {
    try { logger?.warn?.(JSON.stringify(diagnostic)); } catch { /* diagnostics must never affect tracking */ }
  }
  if (!adapter || typeof adapter.track !== "function") {
    if (code === "DELHIVERY") {
      const configuration = readDelhiveryConfiguration(environment);
      const error = new Error(configuration ? "Delhivery tracking is disabled." : "Delhivery tracking configuration is missing.");
      error.code = configuration && isDelhiveryFeatureEnabled("TRACKING", environment) === false
        ? "TRACKING_FEATURE_DISABLED" : "DELHIVERY_CONFIGURATION_ERROR";
      throw error;
    }
    return null;
  }
  return singleFlight(`tracking:${row.owner}:${row._id}`, async () => {
    const providerResult = await withSafeReadRetry(
      () => adapter.track({ waybill: row.waybill, reference: row.reference, shipmentSnapshot: structuredClone(row) }),
      { policy: "trackingSync" }
    );
    const shipment = await appendTrackingEvents({ Shipment, shipment: row, providerCode: adapter.code, events: providerResult?.events, source, now });
    return shipment && { shipment, empty: providerResult.events.length === 0, providerCode: adapter.code };
  });
}

function createShipmentTrackingRouter({ Shipment, partnerRegistry, now, getEnvironment = () => process.env, logger = console }) {
  const router = express.Router();
  router.use(requireSession);

  router.get("/track", async (req, res) => {
    try {
      const waybill = String(req.query.waybill || "").trim();
      const reference = String(req.query.ref_ids || "").trim();
      if ((!waybill && !reference) || (waybill && reference)) return res.status(400).json({ success: false, message: "Provide either waybill or ref_ids." });
      const row = await readQuery(findOwnedShipment(Shipment, req.user.id, waybill || reference, waybill ? "waybill" : "reference"));
      if (!row) return res.status(404).json({ success: false, message: "Shipment not found." });
      return res.json({ success: true, data: trackingResponse(row) });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Shipment tracking could not be retrieved." });
    }
  });

  router.get("/shipments/:id/tracking", async (req, res) => {
    try {
      const row = await readQuery(Shipment.findOne({ _id: req.params.id, owner: req.user.id, state: "saved" }));
      if (!row) return res.status(404).json({ success: false, message: "Shipment not found." });
      return res.json({ success: true, data: trackingResponse(row) });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Tracking history could not be retrieved." });
    }
  });

  router.post("/shipments/:id/tracking/sync", async (req, res) => {
    try {
      const row = await readQuery(Shipment.findOne({ _id: req.params.id, owner: req.user.id, state: "saved" }));
      if (!row) return res.status(404).json({ success: false, message: "Shipment not found." });
      const updated = await synchronizeShipmentTracking({ Shipment, row, partnerRegistry, now, getEnvironment, logger });
      if (!updated) return res.status(409).json({ success: false, code: "TRACKING_ADAPTER_UNAVAILABLE", message: "Tracking synchronization is not configured for this courier." });
      return res.json({ success: true, data: {
        ...trackingResponse(updated.shipment),
        sync: { outcome: updated.empty ? "NO_EVENTS" : "RECEIVED", providerCode: updated.providerCode },
      } });
    } catch (error) {
      if (error.code === "INVALID_TRACKING_AWB") return res.status(400).json({ success: false, code: error.code, message: error.message });
      if (error.code === "TRACKING_ADAPTER_UNAVAILABLE") return res.status(409).json({ success: false, code: error.code, message: error.message });
      if (error instanceof TrackingInputError) return res.status(502).json({ success: false, code: "INVALID_PROVIDER_EVENTS", message: error.message });
      if (error.status === 409) return res.status(409).json({ success: false, message: error.message });
      const configuration = ["DELHIVERY_CONFIGURATION_ERROR", "DELHIVERY_FEATURE_DISABLED", "TRACKING_FEATURE_DISABLED"].includes(error.code);
      const timeout = ["ECONNABORTED", "ETIMEDOUT"].includes(error.code);
      const status = Number(error.response?.status);
      const hasProviderStatus = Number.isInteger(status) && status >= 100 && status <= 599;
      const code = error.code === "TRACKING_FEATURE_DISABLED" ? "TRACKING_FEATURE_DISABLED" : configuration ? "DELHIVERY_CONFIGURATION_ERROR" : timeout ? "COURIER_TIMEOUT" :
        error.code === "INVALID_TRACKING_RESPONSE" ? "INVALID_TRACKING_RESPONSE" :
          hasProviderStatus ? "COURIER_HTTP_ERROR" : "TRACKING_SYNC_FAILED";
      const message = configuration ? "Delhivery tracking is disabled or its credentials and HTTPS URL are missing." :
        timeout ? "The courier tracking request timed out." :
        hasProviderStatus ? `Courier tracking failed (carrier HTTP ${status}).` :
        error.code === "INVALID_TRACKING_RESPONSE" ? "The courier returned an invalid or mismatched tracking response." :
        "Courier tracking synchronization failed.";
      res.locals.safeErrorCode = code;
      return res.status(configuration ? 503 : timeout ? 504 : 502).json({
        success: false, code, message,
        ...(hasProviderStatus ? { providerStatus: status } : {}),
        ...(error.trackingDiagnostics ? { diagnostics: error.trackingDiagnostics } : {}),
      });
    }
  });
  return router;
}

module.exports = { TrackingInputError, normalizeEvents, sortedEvents, appendTrackingEvents, synchronizeShipmentTracking, createShipmentTrackingRouter };
