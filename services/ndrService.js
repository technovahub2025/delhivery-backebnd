const crypto = require("node:crypto");

// Reuses the detection signals that were already present in ndrController.
const NDR_SIGNAL = /non.?delivery|ndr|delivery attempted|consignee unavailable|customer not available|refused|incomplete address|bad address/i;
const NDR_STATUS = /^(undelivered|exception|delivery attempted)$/i;

function getNdrReason(event = {}) {
  const status = String(event.status || "").trim();
  const description = String(event.description || "").trim();
  const candidates = [status, description].filter(Boolean);
  if (candidates.some(value => NDR_SIGNAL.test(value)) || NDR_STATUS.test(status)) return [...new Set(candidates)].join(" | ");
  return "";
}

function actionHistory(caseRow) {
  return Array.isArray(caseRow.actions) ? caseRow.actions : [];
}

async function persistNdrObservations({ NdrCase, shipment, events, now = () => new Date() }) {
  if (!NdrCase || !shipment?._id || !shipment?.owner || !shipment?.waybill) return [];
  const created = [];
  for (const event of events || []) {
    const reason = getNdrReason(event);
    if (!reason || !event.eventKey || !event.occurredAt) continue;
    const filter = { owner: shipment.owner, shipment: shipment._id, trackingEventKey: event.eventKey };
    const existingQuery = NdrCase.findOne(filter);
    const existing = existingQuery && typeof existingQuery.lean === "function" ? await existingQuery.lean() : await existingQuery;
    if (existing) continue;
    try {
      const row = await NdrCase.create({
        ...filter,
        waybill: String(shipment.waybill),
        reference: shipment.reference || shipment.record?.reference || "",
        customer: shipment.record?.customer || "",
        destination: shipment.record?.destination || shipment.record?.city || "",
        payment: shipment.record?.payment || "",
        providerCode: event.providerCode || shipment.record?.partnerCode || "",
        reason,
        status: "OPEN",
        occurredAt: new Date(event.occurredAt),
        carrierDetails: { location: event.location || "", status: event.status || "", description: event.description || "", source: event.source || "TRACKING" },
        actions: [],
        revision: 0,
        createdAt: now(),
      });
      created.push(row);
    } catch (error) {
      // Concurrent webhook/sync insertion is harmless due the unique event index.
      if (error?.code !== 11000) throw error;
    }
  }
  return created;
}

function publicCase(row) {
  const persisted = row?._id != null;
  return {
    id: persisted ? String(row._id) : null, persisted, shipmentId: String(row.shipment), waybill: row.waybill, reference: row.reference || "",
    customer: row.customer || "", destination: row.destination || "", payment: row.payment || "",
    providerCode: row.providerCode || "", reason: row.reason, status: row.status, occurredAt: row.occurredAt,
    lastUpdated: row.updatedAt || row.occurredAt, createdAt: row.createdAt, carrierDetails: row.carrierDetails || {},
    actions: actionHistory(row), resolvedAt: row.resolvedAt || null,
  };
}

function actionRecord({ action, details, now, status, providerRequestId, result, error }) {
  return {
    id: crypto.randomUUID(), action, details: String(details || "").trim(), status,
    submittedAt: now.toISOString(), ...(providerRequestId && { providerRequestId: String(providerRequestId) }),
    ...(result !== undefined && { result }), ...(error && { error: String(error).slice(0, 500) }),
  };
}

function collectNdrObservations(shipment, events) {
  if (!shipment?._id || !shipment?.owner || !shipment?.waybill) return [];
  return (events || []).flatMap(event => {
    const reason = getNdrReason(event);
    if (!reason || !event.eventKey || !event.occurredAt) return [];
    return [{
      owner: shipment.owner, shipment: shipment._id, trackingEventKey: event.eventKey,
      waybill: String(shipment.waybill), reference: shipment.reference || shipment.record?.reference || "",
      customer: shipment.record?.customer || "", destination: shipment.record?.destination || shipment.record?.city || "",
      payment: shipment.record?.payment || "", providerCode: event.providerCode || shipment.record?.partnerCode || "",
      reason, status: "OPEN", occurredAt: new Date(event.occurredAt),
      carrierDetails: { location: event.location || "", status: event.status || "", description: event.description || "", source: event.source || "TRACKING" },
      actions: [], revision: 0,
    }];
  });
}

module.exports = { getNdrReason, collectNdrObservations, persistNdrObservations, publicCase, actionRecord, actionHistory };
