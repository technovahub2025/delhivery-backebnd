const { mapProviderStatus } = require("./providerStatusMappings");

function isRtoEvent(event = {}, statusMappings = {}) {
  return mapProviderStatus(event.providerCode, "rtoTrigger", event.status, statusMappings) === "RTO_TRIGGER";
}

function progressEvent(event, shipmentId, statusMappings = {}) {
  return {
    eventKey: event.eventKey,
    shipmentId,
    providerCode: event.providerCode || "",
    providerEventId: event.providerEventId || "",
    status: String(event.status || "").trim(),
    lifecycleState: mapProviderStatus(event.providerCode, "rto", event.status, statusMappings) || "UNRESOLVED",
    reason: String(event.description || "").trim(),
    location: String(event.location || "").trim(),
    occurredAt: new Date(event.occurredAt),
    source: event.source || "TRACKING",
  };
}

function rtoReturnDetails(record = {}) {
  const keys = ["returnName", "returnAddress", "returnCity", "returnState", "returnPincode", "returnPhone", "returnWarehouse", "warehouse"];
  return Object.fromEntries(keys.filter(key => record[key] != null && String(record[key]).trim()).map(key => [key, record[key]]));
}

function collectRtoObservations(shipment, events, statusMappings = {}) {
  if (!shipment?._id || !shipment?.owner || !shipment?.waybill) return [];
  return (events || []).flatMap(trigger => {
    const providerCode = trigger.providerCode || shipment.record?.partnerCode || shipment.record?.carrierCode || "";
    if (!isRtoEvent({ ...trigger, providerCode }, statusMappings) || !trigger.eventKey || !Number.isFinite(new Date(trigger.occurredAt).getTime())) return [];
    const progress = (events || []).filter(event => event?.status && Number.isFinite(new Date(event.occurredAt).getTime()) && new Date(event.occurredAt) >= new Date(trigger.occurredAt))
      .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt) || String(a.eventKey).localeCompare(String(b.eventKey)));
    const latest = progress.at(-1) || trigger;
    const latestProvider = latest.providerCode || providerCode;
    const lifecycleState = mapProviderStatus(latestProvider, "rto", latest.status, statusMappings) || "UNRESOLVED";
    return [{
      owner: shipment.owner, originalShipment: shipment._id, triggerEventKey: trigger.eventKey,
      originalWaybill: String(shipment.waybill), originalReference: shipment.reference || shipment.record?.reference || "",
      providerCode, reason: String(trigger.description || "").trim(), status: String(latest.status || trigger.status || "").trim(),
      lifecycleState, occurredAt: new Date(trigger.occurredAt), carrierReference: String(trigger.carrierReference || ""),
      returnDetails: rtoReturnDetails(shipment.record),
    }];
  });
}

async function readQuery(query) { return query && typeof query.lean === "function" ? query.lean() : query; }

async function addHistory({ RtoRecord, record, events, shipmentId, statusMappings = {}, now = () => new Date() }) {
  let current = record;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = Array.isArray(current.statusHistory) ? current.statusHistory : [];
    const eventKeys = new Set(existing.map(event => `${String(event.shipmentId)}:${event.eventKey}`));
    const additions = (events || []).filter(event => event?.eventKey && event.status && Number.isFinite(new Date(event.occurredAt).getTime()) && new Date(event.occurredAt) >= new Date(current.occurredAt))
      .map(event => progressEvent(event, shipmentId, statusMappings))
      .filter(event => !eventKeys.has(`${String(event.shipmentId)}:${event.eventKey}`));
    if (!additions.length) return current;
    const history = [...existing, ...additions].sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt) || String(a.eventKey).localeCompare(String(b.eventKey)));
    const latest = history.at(-1);
    const revision = Number(current.revision || 0);
    const updated = await readQuery(RtoRecord.findOneAndUpdate(
      { _id: current._id, owner: current.owner, revision },
      { $set: { statusHistory: history, status: latest.status, lifecycleState: latest.lifecycleState, revision: revision + 1, updatedAt: now() } },
      { new: true, runValidators: true }
    ));
    if (updated) return updated;
    current = await readQuery(RtoRecord.findOne({ _id: record._id, owner: record.owner }));
    if (!current) return null;
  }
  const error = new Error("RTO history changed concurrently. Reload and retry.");
  error.status = 409;
  throw error;
}

async function persistRtoObservations({ RtoRecord, shipment, events, statusMappings = {}, now = () => new Date() }) {
  if (!RtoRecord || !shipment?._id || !shipment?.owner || !shipment?.waybill) return [];
  const createdOrUpdated = [];
  const candidates = collectRtoObservations(shipment, events, statusMappings).sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
  for (const trigger of candidates) {
    const filter = { owner: shipment.owner, originalShipment: shipment._id, triggerEventKey: trigger.eventKey };
    let row = await readQuery(RtoRecord.findOne(filter));
    if (!row) {
      const triggerHistory = (events || []).filter(event => new Date(event.occurredAt) >= new Date(trigger.occurredAt));
      try {
        row = await RtoRecord.create({
          ...filter,
          originalWaybill: String(shipment.waybill),
          originalReference: shipment.reference || shipment.record?.reference || "",
          providerCode: trigger.providerCode || shipment.record?.partnerCode || "",
          reason: String(trigger.reason || "").trim(),
          status: String(trigger.status).trim(),
          lifecycleState: trigger.lifecycleState || "UNRESOLVED",
          occurredAt: new Date(trigger.occurredAt),
          carrierReference: String(trigger.carrierReference || ""),
          returnDetails: rtoReturnDetails(shipment.record),
          statusHistory: [],
          revision: 0,
          createdAt: now(),
        });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        row = await readQuery(RtoRecord.findOne(filter));
      }
    }
    if (row) {
      const updated = await addHistory({ RtoRecord, record: row, events: (events || []).map(event => ({ ...event, providerCode: event.providerCode || shipment.record?.partnerCode })), shipmentId: shipment._id, statusMappings, now });
      if (updated) createdOrUpdated.push(updated);
    }
  }
  return createdOrUpdated;
}

async function appendReturnProgress({ RtoRecord, rto, shipment, statusMappings = {}, now = () => new Date() }) {
  return addHistory({ RtoRecord, record: rto, events: (shipment.trackingEvents || []).map(event => ({ ...event, providerCode: event.providerCode || shipment.record?.partnerCode })), shipmentId: shipment._id, statusMappings, now });
}

function publicRto(row, returnShipment = null) {
  const persisted = row?._id != null;
  return {
    id: persisted ? String(row._id) : null, persisted, originalShipmentId: String(row.originalShipment), returnShipmentId: row.returnShipment ? String(row.returnShipment) : null,
    originalWaybill: row.originalWaybill, originalReference: row.originalReference || "", providerCode: row.providerCode || "",
    triggerEventKey: row.triggerEventKey, reason: row.reason || "", status: row.status, lifecycleState: row.lifecycleState || "UNRESOLVED", occurredAt: row.occurredAt,
    carrierReference: row.carrierReference || "", returnDetails: row.returnDetails || {}, statusHistory: row.statusHistory || [],
    returnShipment: returnShipment ? { id: String(returnShipment._id), waybill: returnShipment.waybill || "", reference: returnShipment.reference || "", status: returnShipment.trackingStatus || returnShipment.record?.status || "" } : null,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

module.exports = { isRtoEvent, collectRtoObservations, progressEvent, persistRtoObservations, appendReturnProgress, publicRto, rtoReturnDetails };
