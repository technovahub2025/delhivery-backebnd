const express = require("express");
const { createHash } = require("node:crypto");
const mongoose = require("mongoose");
const requireSession = require("../utils/requireSession");
const { mapProviderStatus } = require("./providerStatusMappings");
const { withSafeReadRetry, singleFlight } = require("../utils/safeReadRetry");
const { safeProviderSnapshot } = require("../utils/delhiveryError");
const { registeredWarehouseFilter } = require("./warehouseValidation");

class PickupInputError extends Error {}
const isObject = value => value && typeof value === "object" && !Array.isArray(value);
const parseWeightKg = value => {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text) return NaN;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : NaN;
};
const STATUS_LABELS = {
  SCHEDULED: "Scheduled", ASSIGNED: "Assigned", PICKED_UP: "Picked up", FAILED: "Failed",
  COMPLETED: "Completed", CANCELLED: "Cancelled",
};
const LOCAL_TRANSITIONS = {
  Pending: ["SCHEDULED", "ASSIGNED", "PICKED_UP", "FAILED", "COMPLETED", "CANCELLED"],
  Scheduled: ["ASSIGNED", "PICKED_UP", "FAILED", "CANCELLED"],
  Assigned: ["PICKED_UP", "FAILED", "CANCELLED"],
  Rescheduled: ["ASSIGNED", "PICKED_UP", "FAILED", "CANCELLED"],
  Failed: ["CANCELLED"],
};
function pickupIsOpenForDuplicate(row) {
  if (["Cancelled", "Completed", "Picked up", "Failed"].includes(row.status)) return false;
  if (row.status === "Submission failed" && row.carrierSubmissionStatus === "FAILED" && row.submissionAttempt && (row.submissionAttempt.providerDispatched === false || (row.submissionAttempt.providerDispatched === true && row.submissionAttempt.providerOutcome === "REJECTED" && row.submissionAttempt.providerResponse))) return false;
  return true;
}

function serialize(row, carrierSyncAvailable = false) {
  const location = row.location || { name: row.warehouse, contactName: "", phone: "", email: "", address: "", city: "", state: "", pincode: "" };
  return {
    id: String(row._id), recordId: String(row._id), carrierRequestId: row.carrierRequestId || "", providerCode: row.providerCode || "", carrierSubmissionStatus: row.carrierSubmissionStatus || "", submissionAttempt: row.submissionAttempt || null,
    date: row.pickupDate, time: row.pickupTime, warehouse: row.warehouse, location,
    timeTo: row.pickupTimeTo || null, instructions: row.instructions || "",
    shipmentCount: row.shipmentCount ?? (row.shipmentRefs?.length || null),
    count: row.packageCount, totalWeightKg: row.totalWeightKg ?? null,
    shipmentRefs: row.shipmentRefs || [], status: row.status || "Scheduled", history: row.history || [],
    workflow: row.workflow || "CARRIER", revision: Number(row.revision) || 0, createdAt: row.createdAt, updatedAt: row.updatedAt,
    carrierSyncAvailable,
    availableStatuses: row.workflow === "LOCAL" ? (LOCAL_TRANSITIONS[row.status] || [])
      .filter(code => code !== "CANCELLED").map(code => ({ code, label: STATUS_LABELS[code] })) : [],
  };
}

function pickupDetails(body, date, time, current = {}) {
  const end = Object.hasOwn(body, "pickupTimeTo") ? body.pickupTimeTo : current.pickupTimeTo;
  const pickupTimeTo = end ? normalizeDateTime(date, end).time : null;
  if (pickupTimeTo && pickupTimeTo <= time) throw new PickupInputError("Pickup end time must be after the start time.");
  const instructions = Object.hasOwn(body, "instructions") ? body.instructions : current.instructions || "";
  if (typeof instructions !== "string" || instructions.trim().length > 500) throw new PickupInputError("Pickup instructions must be up to 500 characters.");
  return { pickupTimeTo, instructions: instructions.trim() };
}

function shipmentCountOf(value, links) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < links.length || value < 1) {
    throw new PickupInputError("Shipment count must be a positive whole number at least as large as the number of linked shipments.");
  }
  return value;
}

function normalizeDateTime(date, time) {
  const dateText = String(date || "").trim();
  const timeText = String(time || "").trim();
  const parsedDate = new Date(`${dateText}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== dateText) throw new PickupInputError("Pickup date must be a valid YYYY-MM-DD date.");
  if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(timeText)) throw new PickupInputError("Pickup time must use HH:mm or HH:mm:ss.");
  return { date: dateText, time: timeText.length === 5 ? `${timeText}:00` : timeText };
}

function validateLocation(value) {
  if (!isObject(value)) throw new PickupInputError("Pickup location details are required.");
  const location = {
    name: String(value.name || "").trim(), contactName: String(value.contactName || "").trim(),
    phone: String(value.phone || "").trim(), email: String(value.email || "").trim(),
    address: String(value.address || "").trim(), city: String(value.city || "").trim(),
    state: String(value.state || "").trim(), pincode: String(value.pincode || "").trim(),
  };
  if (!location.name || !location.contactName || !location.phone || !location.address || !/^\d{6}$/.test(location.pincode)) throw new PickupInputError("Pickup name, contact, phone, full address and six-digit pincode are required.");
  if (location.phone.length > 20 || !/^\+?[0-9 ()-]{7,20}$/.test(location.phone)) throw new PickupInputError("Pickup phone number is invalid.");
  if (location.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(location.email)) throw new PickupInputError("Pickup email address is invalid.");
  if (Object.values(location).some(text => text.length > 500)) throw new PickupInputError("Pickup location fields exceed the supported length.");
  return location;
}

async function resolvePickupShipmentRefs(Shipment, owner, values, { provider } = {}) {
  if (!Array.isArray(values)) throw new PickupInputError("shipmentRefs must be an array.");
  const refs = [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];
  if (refs.length > 50 || refs.some(value => value.length > 160)) throw new PickupInputError("Shipment references are invalid.");
  if (!refs.length) return [];
  const rows = await Shipment.find({ owner, state: "saved", $or: [{ waybill: { $in: refs } }, { reference: { $in: refs } }] }).select("_id waybill reference record.mockOnly record.partnerCode record.providerCode record.carrierCode").lean();
  const linked = rows.filter(row => provider
    ? row.record?.mockOnly !== true && /^\d{6,20}$/.test(row.waybill || "") &&
      (row.record?.partnerCode || row.record?.providerCode || row.record?.carrierCode) === provider
    : Boolean(String(row.waybill || "").trim()) || row.record?.mockOnly === true)
    .map(row => ({ shipmentId: String(row._id), waybill: String(row.waybill || ""), reference: String(row.reference || "") }));
  const matched = new Set(linked.flatMap(row => [row.waybill, row.reference]).filter(Boolean));
  if (refs.some(ref => !matched.has(ref))) throw new PickupInputError("One or more linked shipments are unavailable for this account and pickup.");
  return linked;
}

async function validatePickupShipmentReadiness(Shipment, owner, values, warehouseName) {
  const refs = [...new Set((Array.isArray(values) ? values : []).map(value => String(value || "").trim()).filter(Boolean))];
  if (!refs.length) return [];
  const rows = await Shipment.find({ owner, state: "saved", $or: [{ waybill: { $in: refs } }, { reference: { $in: refs } }] }).select("_id owner state kind waybill reference record").lean();
  const byRef = new Map(rows.flatMap(row => [row.waybill, row.reference].filter(Boolean).map(ref => [String(ref), row])));
  const normalizedWarehouse = String(warehouseName || "").trim().toLowerCase();
  return refs.map(ref => {
    const row = byRef.get(ref);
    if (!row || row.owner !== owner) return { ref, ok: false, reason: "Shipment is not available for this account." };
    if (row.state !== "saved") return { ref, ok: false, reason: "Shipment is not manifested/saved." };
    if (row.kind && row.kind !== "forward") return { ref, ok: false, reason: "Only forward shipments can be picked up." };
    if (!/^\d{6,20}$/.test(String(row.waybill || ""))) return { ref, ok: false, reason: "Shipment does not have a valid carrier waybill." };
    if (row.record?.providerCode !== "DELHIVERY") return { ref, ok: false, reason: "Shipment is not a Delhivery shipment." };
    if (row.record?.providerOutcome !== "PROVIDER_CONFIRMED") return { ref, ok: false, reason: "Shipment manifestation is not provider-confirmed." };
    if (String(row.record?.status || "") === "Cancelled") return { ref, ok: false, reason: "Cancelled shipments cannot be picked up." };
    if (String(row.record?.status || "") !== "Pending pickup") return { ref, ok: false, reason: "Shipment is not pending pickup." };
    const shipmentWarehouse = String(row.record?.warehouse || "").trim().toLowerCase();
    if (!shipmentWarehouse) return { ref, ok: false, reason: "Shipment has no registered warehouse association." };
    if (shipmentWarehouse !== normalizedWarehouse) return { ref, ok: false, reason: "Shipment warehouse does not match the pickup warehouse." };
    return { ref, ok: true, shipmentId: String(row._id), waybill: String(row.waybill) };
  });
}

function createPickupRequestRouter({ PickupRequest, Shipment, Warehouse, partnerRegistry, statusMappings = {} }) {
  const router = express.Router();
  router.use(requireSession);
  const syncAdapter = pickup => pickup.workflow === "CARRIER" && pickup.carrierRequestId
    ? partnerRegistry?.get(pickup.providerCode) : null;
  const view = pickup => serialize(pickup, typeof syncAdapter(pickup)?.syncPickup === "function");
  const resolveShipmentRefs = (owner, values) => resolvePickupShipmentRefs(Shipment, owner, values);

  router.get("/", async (req, res) => {
    try {
      const records = await PickupRequest.find({ owner: req.user.id }).sort({ createdAt: -1, _id: -1 }).limit(200).lean();
      const pickups = records.map(view);
      return res.json({ success: true, data: { pickups, total: pickups.length } });
    } catch { return res.status(503).json({ success: false, message: "Pickup requests could not be loaded." }); }
  });

  router.post("/", async (req, res) => {
    let replayFilter, fingerprint;
    const replay = row => {
      if (row.localRequestFingerprint !== fingerprint) {
        return res.status(409).json({ success: false, code: "PICKUP_REQUEST_KEY_CONFLICT", message: "This pickup request key was already used with different details." });
      }
      res.locals.skipBusinessAudit = true;
      return res.json({ success: true, data: { pickup: serialize(row), carrierSubmission: "NOT_CONFIGURED", replayed: true } });
    };
    try {
      const body = req.body || {};
      const localRequestKey = body.idempotencyKey;
      if (localRequestKey !== undefined && (typeof localRequestKey !== "string" || !/^[a-zA-Z0-9-]{16,100}$/.test(localRequestKey))) {
        throw new PickupInputError("Invalid pickup request key.");
      }
      const { date, time } = normalizeDateTime(body.pickupDate, body.pickupTime);
      const details = pickupDetails(body, date, time);
      const location = validateLocation(body.location);
      const packageCount = Number(body.packageCount);
      const totalWeightKg = parseWeightKg(body.totalWeightKg);
      if (!Number.isSafeInteger(packageCount) || packageCount < 1) throw new PickupInputError("Package count must be a positive whole number.");
      if (!Number.isFinite(totalWeightKg) || totalWeightKg <= 0) throw new PickupInputError("Total weight must be greater than zero kilograms.");
      const rawRefs = body.shipmentRefs === undefined ? [] : body.shipmentRefs;
      if (localRequestKey) {
        if (!Array.isArray(rawRefs)) throw new PickupInputError("shipmentRefs must be an array.");
        const refs = [...new Set(rawRefs.map(value => String(value || "").trim()).filter(Boolean))].sort();
        fingerprint = createHash("sha256").update(JSON.stringify({
          date, time, details, location, packageCount, totalWeightKg, refs, shipmentCount: body.shipmentCount ?? null,
        })).digest("hex");
        replayFilter = { owner: req.user.id, localRequestKey };
        const existing = await PickupRequest.findOne(replayFilter).lean();
        if (existing) return replay(existing);
      }
      const shipmentRefs = await resolveShipmentRefs(req.user.id, rawRefs);
      const shipmentCount = shipmentCountOf(body.shipmentCount, shipmentRefs);
      const request = { pickupDate: date, pickupTime: time, ...details, location, packageCount, totalWeightKg, shipmentRefs, shipmentCount };
      const row = await PickupRequest.create({
        owner: req.user.id, carrierRequestId: "", pickupDate: date, pickupTime: time, ...details,
        warehouse: location.name, location, packageCount, totalWeightKg, shipmentRefs, shipmentCount,
        status: "Pending", workflow: "LOCAL", revision: 0, request,
        ...(localRequestKey ? { localRequestKey, localRequestFingerprint: fingerprint } : {}),
        carrierResponse: { status: "NOT_SUBMITTED", description: "Local pickup request saved; no carrier request was sent." },
        history: [{ action: "CREATED", status: "Pending", timestamp: new Date(), description: "Pickup request saved locally; awaiting carrier submission.", actor: req.user.id }],
      });
      return res.status(201).json({ success: true, data: { pickup: serialize(row), carrierSubmission: "NOT_CONFIGURED" } });
    } catch (error) {
      if (error instanceof PickupInputError) return res.status(400).json({ success: false, message: error.message });
      if (error?.code === 11000 && replayFilter) {
        try {
          const existing = await PickupRequest.findOne(replayFilter).lean();
          if (existing) return replay(existing);
        } catch { /* Return the same non-sensitive availability error. */ }
      }
      return res.status(503).json({ success: false, message: "Pickup request could not be saved." });
    }
  });

  router.get("/:id/debug-readiness", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid pickup request ID." });
    try {
      const pickup = await PickupRequest.findOne({ _id: req.params.id, owner: req.user.id }).select("owner warehouse pickupDate status workflow carrierSubmissionStatus shipmentRefs").lean();
      if (!pickup) return res.status(404).json({ success: false, message: "Pickup request not found." });
      const refs = (pickup.shipmentRefs || []).flatMap(row => [row.waybill, row.reference]).filter(Boolean).map(String);
      const shipment = refs.length ? await Shipment.findOne({ owner: req.user.id, $or: [{ waybill: { $in: refs } }, { reference: { $in: refs } }] }).select("owner state kind waybill reference record").lean() : null;
      const warehouse = Warehouse ? await Warehouse.findOne({ owner: req.user.id, nameKey: String(pickup.warehouse || "").trim().toLowerCase(), ...registeredWarehouseFilter() }).select("owner name nameKey state registrationStatus").lean() : null;
      const actual = shipment ? { owner: shipment.owner, state: shipment.state, kind: shipment.kind ?? null, waybill: shipment.waybill || "", providerCode: shipment.record?.providerCode || null, providerOutcome: shipment.record?.providerOutcome || null, status: shipment.record?.status || null, warehouse: shipment.record?.warehouse || null } : null;
      const expectedWarehouse = warehouse?.name || pickup.warehouse;
      const predicates = actual ? [
        ["owner", actual.owner === req.user.id, actual.owner], ["saved state", actual.state === "saved", actual.state], ["forward or legacy kind", !actual.kind || actual.kind === "forward", actual.kind], ["numeric waybill", /^\d{6,20}$/.test(actual.waybill), actual.waybill], ["Delhivery provider", actual.providerCode === "DELHIVERY", actual.providerCode], ["provider confirmed", actual.providerOutcome === "PROVIDER_CONFIRMED", actual.providerOutcome], ["Pending pickup status", actual.status === "Pending pickup", actual.status], ["not cancelled", actual.status !== "Cancelled", actual.status], ["warehouse exists", Boolean(actual.warehouse), actual.warehouse], ["warehouse matches registered name", Boolean(actual.warehouse) && actual.warehouse.trim().toLowerCase() === String(expectedWarehouse).trim().toLowerCase(), actual.warehouse],
      ] : [["linked shipment found", false, null]];
      const sameDay = await PickupRequest.find({ owner: req.user.id, warehouse: expectedWarehouse, pickupDate: pickup.pickupDate }).select("_id status workflow carrierSubmissionStatus submissionAttempt").lean();
      const open = sameDay.filter(row => String(row._id) !== String(pickup._id) && pickupIsOpenForDuplicate(row));
      return res.json({ success: true, data: { pickup: { owner: pickup.owner, warehouse: pickup.warehouse, pickupDate: pickup.pickupDate, status: pickup.status, workflow: pickup.workflow, carrierSubmissionStatus: pickup.carrierSubmissionStatus || null, shipmentRefs: refs }, shipment: actual, registeredWarehouse: warehouse && { owner: warehouse.owner, name: warehouse.name, nameKey: warehouse.nameKey, state: warehouse.state, registrationStatus: warehouse.registrationStatus }, predicates: predicates.map(([name, pass, value]) => ({ name, pass, value })), duplicateGuard: { pass: open.length === 0, openCount: open.length, openPickups: open.map(row => ({ id: String(row._id), status: row.status, workflow: row.workflow, carrierSubmissionStatus: row.carrierSubmissionStatus || null })) } } });
    } catch { return res.status(503).json({ success: false, message: "Pickup readiness diagnostic could not be loaded." }); }
  });

  router.post("/:id/submit", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid pickup request ID." });
    let current;
    try {
      current = await PickupRequest.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      if (!current) return res.status(404).json({ success: false, message: "Pickup request not found." });
      if (current.workflow !== "LOCAL") return res.status(409).json({ success: false, message: "This pickup has already been submitted to a carrier." });
      if (["Picked up", "Completed", "Cancelled"].includes(current.status) || current.carrierSubmissionStatus === "OUTCOME_UNCONFIRMED") return res.status(409).json({ success: false, message: current.carrierSubmissionStatus === "OUTCOME_UNCONFIRMED" ? "Carrier outcome is unconfirmed; reconcile it before retrying." : "This pickup is not eligible for carrier submission." });
      const warehouse = Warehouse ? await Warehouse.findOne({ owner: req.user.id, nameKey: String(current.warehouse || "").trim().toLowerCase(), ...registeredWarehouseFilter() }).lean() : null;
      if (Warehouse && !warehouse) return res.status(400).json({ success: false, message: "Registered pickup warehouse not found for this account." });
      const registeredName = warehouse?.name || current.warehouse;
      const readiness = await validatePickupShipmentReadiness(Shipment, req.user.id, (current.shipmentRefs || []).flatMap(row => [row.waybill, row.reference]).filter(Boolean), registeredName);
      const failedShipment = readiness.find(item => !item.ok);
      if (failedShipment) return res.status(400).json({ success: false, code: "PICKUP_SHIPMENT_NOT_READY", message: `Linked shipment ${failedShipment.ref} is not eligible: ${failedShipment.reason}` });
      const sameDay = await PickupRequest.find({ owner: req.user.id, _id: { $ne: current._id }, warehouse: registeredName, pickupDate: current.pickupDate }).select("_id status workflow carrierSubmissionStatus submissionAttempt").lean();
      const existingOpen = sameDay.find(pickupIsOpenForDuplicate);
      if (existingOpen) return res.status(409).json({ success: false, code: "PICKUP_SAME_DAY_OPEN", message: "Another pickup for this warehouse and date is still open." });
      const weight = parseWeightKg(current.totalWeightKg);
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(current.pickupDate)) || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(current.pickupTime)) || !Number.isSafeInteger(current.packageCount) || current.packageCount < 1 || !Number.isFinite(weight) || weight <= 0) return res.status(400).json({ success: false, message: "Pickup date, time, package count and positive total weight are required." });
      const revision = Number(current.revision || 0);
      const claimTimestamp = new Date();
      const claimed = await PickupRequest.findOneAndUpdate({ _id: current._id, owner: req.user.id, workflow: "LOCAL", status: current.status, revision, carrierSubmissionStatus: { $in: [null, ""] } }, { $set: { carrierSubmissionStatus: "SUBMITTING", status: "Submitting", submissionAttempt: { stage: "CLAIMED", providerDispatched: false, claimTimestamp, outcome: "IN_PROGRESS" } }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
      if (!claimed) return res.status(409).json({ success: false, message: "Pickup submission is already in progress or has changed. Reload before retrying." });
      const adapter = partnerRegistry?.get("DELHIVERY");
      if (!adapter || typeof adapter.createPickup !== "function") throw Object.assign(new Error("Delhivery pickup submission is not configured."), { definitive: true, localFailure: true });
      const request = { pickup_date: claimed.pickupDate, pickup_time: claimed.pickupTime, pickup_location: registeredName, expected_package_count: claimed.packageCount };
      const evidenceWrite = async (set) => { try { await PickupRequest.updateOne({ _id: claimed._id, owner: req.user.id, carrierSubmissionStatus: "SUBMITTING" }, { $set: { submissionAttempt: { ...(claimed.submissionAttempt || {}), ...set } } }); } catch (writeError) { console.warn(JSON.stringify({ event: "pickup.submission_evidence_failed", pickupId: String(claimed._id), message: String(writeError.message || "evidence write failed").slice(0, 200) })); throw writeError; } };
      const result = await adapter.createPickup({ request,
        onDispatchStarted: timestamp => evidenceWrite({ stage: "DISPATCH_STARTED", providerDispatched: true, dispatchTimestamp: timestamp, outcome: "IN_PROGRESS" }),
        onProviderResponse: meta => evidenceWrite({ stage: "PROVIDER_RESPONSE", providerDispatched: true, providerHttpStatus: meta.status, responseReceivedAt: meta.receivedAt, providerResponse: safeProviderSnapshot(meta.body), outcome: "RESPONSE_RECEIVED" }),
        onProviderError: (error, meta) => evidenceWrite({ stage: "PROVIDER_RESPONSE", providerDispatched: true, providerHttpStatus: meta.status, responseReceivedAt: meta.receivedAt, providerResponse: safeProviderSnapshot(meta.body), providerErrorName: error.name, providerErrorMessage: String(error.message || "provider error").slice(0, 200), outcome: error.outcome || "REJECTED" }),
        onTransportError: (error, timestamp) => evidenceWrite({ stage: "DISPATCH_STARTED", providerDispatched: true, dispatchTimestamp: timestamp, providerErrorName: error.name, providerErrorMessage: String(error.message || "transport error").slice(0, 200), outcome: "AMBIGUOUS" }),
      });
      const history = [...(claimed.history || []), { action: "CARRIER_SUBMITTED", status: "Scheduled", timestamp: new Date(), description: "Pickup submitted to Delhivery and confirmed.", actor: req.user.id }];
      const saved = await PickupRequest.findOneAndUpdate({ _id: claimed._id, owner: req.user.id, carrierSubmissionStatus: "SUBMITTING", revision: revision + 1 }, { $set: { workflow: "CARRIER", carrierRequestId: result.carrierRequestId, providerCode: "DELHIVERY", carrierSubmissionStatus: "CONFIRMED", status: "Scheduled", carrierResponse: result.responseSnapshot, history }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
      return saved ? res.json({ success: true, data: { pickup: serialize(saved), carrierSubmission: "CONFIRMED" } }) : res.status(409).json({ success: false, message: "Pickup changed during carrier submission." });
    } catch (error) {
      if (!current) return res.status(502).json({ success: false, message: "Pickup submission failed." });
      const ambiguous = !error?.definitive && error?.outcome !== "REJECTED";
      const localFailure = error?.localFailure === true;
      const safeLocalMessage = localFailure ? String(error?.message || "Delhivery pickup adapter is not configured.").slice(0, 200) : undefined;
      try { await PickupRequest.updateOne({ _id: current._id, owner: req.user.id, carrierSubmissionStatus: "SUBMITTING" }, { $set: { carrierSubmissionStatus: "FAILED", status: ambiguous ? "Outcome unconfirmed" : "Submission failed", submissionAttempt: { stage: localFailure ? "VALIDATION" : error?.responseSnapshot ? "PROVIDER_RESPONSE" : "DISPATCH", providerDispatched: !localFailure, providerResponse: error?.responseSnapshot || undefined, providerOutcome: ambiguous ? "AMBIGUOUS" : "REJECTED", localErrorMessage: safeLocalMessage, completedAt: new Date() } }, $push: { history: { action: ambiguous ? "CARRIER_OUTCOME_UNCONFIRMED" : "CARRIER_SUBMISSION_FAILED", status: ambiguous ? "Outcome unconfirmed" : "Submission failed", timestamp: new Date(), description: localFailure ? "Submission failed before provider dispatch." : ambiguous ? "Provider outcome could not be confirmed; reconciliation is required." : "Provider explicitly rejected the pickup submission.", actor: req.user.id } } }); } catch { /* retain claim */ }
      if (localFailure) return res.status(503).json({ success: false, code: "DELHIVERY_CONFIGURATION_ERROR", message: "Delhivery pickup submission is not configured." });
      return res.status(ambiguous ? 502 : 400).json({ success: false, code: ambiguous ? "PICKUP_OUTCOME_UNCONFIRMED" : "PICKUP_SUBMISSION_FAILED", message: ambiguous ? "Delhivery did not confirm pickup creation. Reconcile before retrying." : "Delhivery rejected the pickup request." });
    }
  });

  router.post("/:id/recover", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid pickup request ID." });
    if (req.authz?.permissions && !req.authz.permissions.includes("pickup_requests.recover")) return res.status(403).json({ success: false, code: "PERMISSION_DENIED", message: "Recovery permission is required." });
    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 10 || reason.length > 500) return res.status(400).json({ success: false, message: "Provide an operator recovery reason of 10 to 500 characters." });
    const current = await PickupRequest.findOne({ _id: req.params.id, owner: req.user.id }).lean();
    if (!current) return res.status(404).json({ success: false, message: "Pickup request not found." });
    const evidence = current.submissionAttempt || {};
    const safe = current.carrierSubmissionStatus === "FAILED" && (evidence.providerDispatched === false || (evidence.providerDispatched === true && evidence.providerOutcome === "REJECTED" && evidence.providerResponse));
    if (!safe) return res.status(409).json({ success: false, code: "PICKUP_RECOVERY_UNSAFE", message: "This pickup does not have sufficient evidence for safe recovery." });
    const history = [...(current.history || []), { action: "CARRIER_SUBMISSION_RECOVERED", status: "Pending", timestamp: new Date(), description: reason, actor: req.user.id }];
    const saved = await PickupRequest.findOneAndUpdate({ _id: current._id, owner: req.user.id, workflow: "LOCAL", carrierSubmissionStatus: "FAILED", revision: Number(current.revision || 0) }, { $set: { carrierSubmissionStatus: null, status: "Pending", submissionAttempt: { ...evidence, recoveredAt: new Date(), recoveryReason: reason, recoveredBy: req.user.id }, history }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
    return saved ? res.json({ success: true, data: { pickup: serialize(saved), recovery: "AUTHORIZED" } }) : res.status(409).json({ success: false, message: "Pickup changed during recovery. Reload before retrying." });
  });

  router.post("/:id/cancel-failed", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid pickup request ID." });
    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 10 || reason.length > 500) return res.status(400).json({ success: false, message: "Provide a cancellation reason of 10 to 500 characters." });
    try {
      const current = await PickupRequest.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      if (!current) return res.status(404).json({ success: false, message: "Pickup request not found." });
      if (current.workflow !== "LOCAL" || current.carrierSubmissionStatus !== "FAILED" || current.status !== "Submission failed") return res.status(409).json({ success: false, message: "Only definitively failed local pickup requests can be cancelled this way." });
      const history = [...(current.history || []), { action: "LOCAL_CANCELLED", status: "Cancelled", timestamp: new Date(), description: reason, actor: req.user.id }];
      const saved = await PickupRequest.findOneAndUpdate({ _id: current._id, owner: req.user.id, workflow: "LOCAL", status: "Submission failed", carrierSubmissionStatus: "FAILED", revision: Number(current.revision || 0) }, { $set: { status: "Cancelled", history }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
      return saved ? res.json({ success: true, data: { pickup: serialize(saved), carrierCancellation: "NOT_SUBMITTED" } }) : res.status(409).json({ success: false, message: "Pickup changed during cancellation. Reload before retrying." });
    } catch { return res.status(503).json({ success: false, message: "Pickup cancellation could not be saved." }); }
  });

  router.get("/:id", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid pickup request ID." });
    try {
      const row = await PickupRequest.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      return row ? res.json({ success: true, data: { pickup: view(row) } }) : res.status(404).json({ success: false, message: "Pickup request not found." });
    } catch { return res.status(503).json({ success: false, message: "Pickup request could not be loaded." }); }
  });

  router.patch("/:id", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid pickup request ID." });
    try {
      const current = await PickupRequest.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      if (!current) return res.status(404).json({ success: false, message: "Pickup request not found." });
      if (current.workflow !== "LOCAL") return res.status(409).json({ success: false, message: "Carrier-backed pickup changes require a configured carrier adapter." });
      if (["Picked up", "Completed", "Cancelled"].includes(current.status)) return res.status(409).json({ success: false, message: "Picked-up, completed or cancelled pickup requests cannot be changed." });
      const body = req.body || {};
      const { date, time } = normalizeDateTime(body.pickupDate ?? current.pickupDate, body.pickupTime ?? current.pickupTime);
      const details = pickupDetails(body, date, time, current);
      const location = validateLocation(body.location ?? current.location);
      const packageCount = body.packageCount === undefined ? current.packageCount : Number(body.packageCount);
      const totalWeightKg = body.totalWeightKg === undefined ? current.totalWeightKg : Number(body.totalWeightKg);
      if (!Number.isSafeInteger(packageCount) || packageCount < 1) throw new PickupInputError("Package count must be a positive whole number.");
      if (!Number.isFinite(totalWeightKg) || totalWeightKg <= 0) throw new PickupInputError("Total weight must be greater than zero kilograms.");
      const shipmentRefs = await resolveShipmentRefs(req.user.id, body.shipmentRefs ?? (current.shipmentRefs || []).flatMap(row => [row.waybill, row.reference]).filter(Boolean));
      const shipmentCount = shipmentCountOf(Object.hasOwn(body, "shipmentCount") ? body.shipmentCount : current.shipmentCount, shipmentRefs);
      const rescheduled = date !== current.pickupDate || time !== current.pickupTime || details.pickupTimeTo !== (current.pickupTimeTo || null);
      const status = rescheduled ? "Rescheduled" : current.status;
      const action = rescheduled ? "RESCHEDULED" : "UPDATED";
      const next = { pickupDate: date, pickupTime: time, ...details, warehouse: location.name, location, packageCount, totalWeightKg, shipmentRefs, shipmentCount, status,
        request: { ...(current.request || {}), pickupDate: date, pickupTime: time, ...details, location, packageCount, totalWeightKg, shipmentRefs, shipmentCount },
        history: [...(current.history || []), { action, status, timestamp: new Date(), description: rescheduled ? "Pickup date or time changed." : "Pickup request details updated.", actor: req.user.id }] };
      const revision = Number(current.revision) || 0;
      const saved = await PickupRequest.findOneAndUpdate({ _id: current._id, owner: req.user.id, workflow: "LOCAL", status: current.status, revision }, { $set: next, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
      return saved ? res.json({ success: true, data: { pickup: serialize(saved) } }) : res.status(409).json({ success: false, message: "Pickup request changed. Reload it before editing." });
    } catch (error) {
      if (error instanceof PickupInputError) return res.status(400).json({ success: false, message: error.message });
      return res.status(503).json({ success: false, message: "Pickup request could not be updated." });
    }
  });

  async function cancel(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid pickup request ID." });
    try {
      const current = await PickupRequest.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      if (!current) return res.status(404).json({ success: false, message: "Pickup request not found." });
      if (current.workflow !== "LOCAL") return res.status(409).json({ success: false, message: "Carrier-backed pickup cancellation requires a configured carrier adapter." });
      if (["Picked up", "Completed", "Cancelled"].includes(current.status)) return res.status(409).json({ success: false, message: "Pickup request is already picked up, completed or cancelled." });
      const history = [...(current.history || []), { action: "CANCELLED", status: "Cancelled", timestamp: new Date(), description: "Pickup request cancelled locally; no carrier cancellation was sent.", actor: req.user.id }];
      const revision = Number(current.revision) || 0;
      const saved = await PickupRequest.findOneAndUpdate({ _id: current._id, owner: req.user.id, workflow: "LOCAL", status: current.status, revision }, { $set: { status: "Cancelled", history }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
      return saved ? res.json({ success: true, data: { pickup: serialize(saved), carrierCancellation: "NOT_SUBMITTED" } }) : res.status(409).json({ success: false, message: "Pickup request changed. Reload it before cancelling." });
    } catch { return res.status(503).json({ success: false, message: "Pickup request could not be cancelled." }); }
  }

  router.post("/:id/cancel", cancel);
  router.delete("/:id", cancel);

  router.post("/:id/status", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid pickup request ID." });
    try {
      const current = await PickupRequest.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      if (!current) return res.status(404).json({ success: false, message: "Pickup request not found." });
      if (current.workflow !== "LOCAL") return res.status(409).json({ success: false, message: "Carrier-backed pickup status must be synchronized through its courier adapter." });
      const requested = String(req.body?.status || "").trim().toUpperCase();
      if (!Object.hasOwn(LOCAL_TRANSITIONS, current.status) || !LOCAL_TRANSITIONS[current.status].includes(requested)) {
        return res.status(409).json({ success: false, message: "This local pickup status transition is not allowed." });
      }
      const status = STATUS_LABELS[requested];
      const timestamp = new Date();
      const history = [...(current.history || []), { action: requested, status, timestamp, description: "Status recorded by an account operator; no carrier status was asserted.", actor: req.user.id }];
      const saved = await PickupRequest.findOneAndUpdate({ _id: current._id, owner: req.user.id, workflow: "LOCAL", status: current.status, revision: Number(current.revision || 0) }, { $set: { status, history }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
      return saved ? res.json({ success: true, data: { pickup: serialize(saved) } }) : res.status(409).json({ success: false, message: "Pickup request changed. Reload and retry." });
    } catch { return res.status(503).json({ success: false, message: "Pickup status could not be updated." }); }
  });

  router.post("/:id/sync", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid pickup request ID." });
    try {
      const current = await PickupRequest.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      if (!current) return res.status(404).json({ success: false, message: "Pickup request not found." });
      if (current.workflow !== "CARRIER") return res.status(409).json({ success: false, message: "Local pickup requests have no carrier status to synchronize." });
      const adapter = syncAdapter(current);
      if (!adapter || typeof adapter.syncPickup !== "function") return res.status(409).json({ success: false, code: "PICKUP_SYNC_UNAVAILABLE", message: "Pickup synchronization is not configured for this courier." });
      const result = await singleFlight(`pickup:${req.user.id}:${current._id}`, () => withSafeReadRetry(
        () => adapter.syncPickup({ carrierRequestId: current.carrierRequestId, pickupSnapshot: structuredClone(current) }),
        { policy: "pickupSync" }
      ));
      const rawStatus = String(result?.status || "").trim();
      const mapped = mapProviderStatus(adapter.code, "pickup", rawStatus, statusMappings);
      if (!mapped) return res.status(409).json({ success: false, code: "PICKUP_STATUS_MAPPING_REQUIRED", message: "This provider pickup status has no configured mapping; the record was not changed." });
      const status = ({ SCHEDULED: "Scheduled", ASSIGNED: "Assigned", PICKED_UP: "Picked up", RESCHEDULED: "Rescheduled", COMPLETED: "Completed", CANCELLED: "Cancelled", FAILED: "Failed" })[mapped];
      const previous = current.history?.at(-1);
      if (current.status === status && previous?.action === "STATUS_SYNCED" && previous.description === `Provider status: ${rawStatus}`) {
        return res.json({ success: true, data: { pickup: view(current), providerStatus: rawStatus, changed: false } });
      }
      const timestamp = new Date();
      const history = [...(current.history || []), { action: "STATUS_SYNCED", status, timestamp, description: `Provider status: ${rawStatus}`, actor: `PROVIDER:${adapter.code}` }];
      const saved = await PickupRequest.findOneAndUpdate({ _id: current._id, owner: req.user.id, workflow: "CARRIER", revision: Number(current.revision || 0) }, { $set: { status, history, carrierResponse: result.responseSnapshot ?? current.carrierResponse }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
      return saved ? res.json({ success: true, data: { pickup: view(saved), providerStatus: rawStatus, changed: true } }) : res.status(409).json({ success: false, message: "Pickup request changed during synchronization." });
    } catch { return res.status(502).json({ success: false, message: "Courier pickup synchronization failed." }); }
  });
  return router;
}

module.exports = createPickupRequestRouter;
Object.assign(module.exports, { PickupInputError, pickupDetails, shipmentCountOf, resolvePickupShipmentRefs, validatePickupShipmentReadiness, serializePickup: serialize });
