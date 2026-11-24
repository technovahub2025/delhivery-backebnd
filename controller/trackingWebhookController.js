const { createHash, timingSafeEqual } = require("node:crypto");
const { appendTrackingEvents, normalizeEvents, TrackingInputError } = require("../services/shipmentTrackingRouter");

function configuredHeaderAuthenticator(value) {
  if (typeof value !== "string" || value.length < 32 || !/^[\x21-\x7e][\x20-\x7e]*[\x21-\x7e]$/.test(value)) return null;
  const hash = input => createHash("sha256").update(input).digest();
  const expected = hash(value);
  return req => {
    const actual = req.get("Authorization");
    return typeof actual === "string" && timingSafeEqual(hash(actual), expected);
  };
}

function createWebhookEventsController({ DelhiveryWebhook, adapter }) {
  return async (req, res) => {
    const { waybill = "", page = "1" } = req.query;
    if (typeof waybill !== "string" || (waybill && !/^\d{6,20}$/.test(waybill)) ||
        typeof page !== "string" || !/^[1-9]\d{0,3}$/.test(page)) {
      return res.status(400).json({ success: false, message: "Provide a valid waybill and page." });
    }
    const size = 25;
    const filter = { owner: req.user.id, providerCode: "DELHIVERY" };
    if (waybill) {
      const candidates = [waybill];
      if (Number.isSafeInteger(Number(waybill)) && String(Number(waybill)) === waybill) candidates.push(Number(waybill));
      filter["payload.Shipment.AWB"] = { $in: candidates };
    }
    try {
      const rows = await DelhiveryWebhook.find(filter)
        .select("createdAt payload.Shipment.AWB payload.Shipment.ReferenceNo payload.Shipment.NSLCode payload.Shipment.Status.Status payload.Shipment.Status.StatusDateTime payload.Shipment.Status.StatusLocation payload.Shipment.Status.StatusType payload.Shipment.Status.StatusCode payload.Shipment.Status.Instructions")
        .sort({ createdAt: -1, _id: -1 }).skip((Number(page) - 1) * size).limit(size + 1).lean();
      const events = rows.slice(0, size).map(row => {
        const { waybill, reference, events: scans } = adapter.normalizeWebhook(row.payload);
        const scan = scans[0];
        return {
          id: String(row._id), waybill, reference: reference.slice(0, 100),
          status: scan?.status || "", location: scan?.location || "", description: scan?.description || "",
          statusType: scan?.statusType || "", statusCode: scan?.statusCode || "",
          occurredAt: scan?.occurredAt || null, receivedAt: row.createdAt,
        };
      });
      return res.json({ success: true, data: { events, page: Number(page), hasMore: rows.length > size } });
    } catch {
      return res.status(503).json({ success: false, message: "Webhook events could not be loaded." });
    }
  };
}

function createTrackingWebhookController({ DelhiveryWebhook, Shipment, partnerRegistry, providerCode = "DELHIVERY", enabled = false, authenticateWebhook = null }) {
  return async function processTrackingWebhook(req, res) {
    const active = typeof enabled === "function" ? enabled() : enabled;
    if (!active || typeof authenticateWebhook !== "function") {
      return res.status(503).json({ success: false, code: "WEBHOOK_PROCESSING_DISABLED", message: "Webhook processing requires enabled and authenticated Scan Push configuration." });
    }

    try {
      if (await authenticateWebhook(req) !== true) return res.status(401).json({ success: false, code: "INVALID_WEBHOOK_SIGNATURE", message: "Webhook authentication failed." });
    } catch {
      return res.status(401).json({ success: false, code: "INVALID_WEBHOOK_SIGNATURE", message: "Webhook authentication failed." });
    }

    const payload = req.body;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Object.keys(payload).length) {
      return res.status(400).json({ success: false, code: "INVALID_WEBHOOK_PAYLOAD", message: "A non-empty JSON object is required." });
    }
    const adapter = partnerRegistry?.get(providerCode);
    if (!adapter || typeof adapter.normalizeWebhook !== "function") return res.status(503).json({ success: false, code: "WEBHOOK_ADAPTER_UNAVAILABLE", message: "A webhook normalization adapter is not configured." });

    try {
      const normalized = await adapter.normalizeWebhook(structuredClone(payload));
      const waybill = String(normalized?.waybill || "").trim();
      if (!/^[A-Za-z0-9-]{1,100}$/.test(waybill) || !Array.isArray(normalized?.events) || normalized.events.length < 1 || normalized.events.length > 100) {
        return res.status(400).json({ success: false, code: "INVALID_WEBHOOK_PAYLOAD", message: "Webhook must identify one valid waybill and contain 1 to 100 tracking events." });
      }
      const events = normalizeEvents(adapter.code, normalized.events, "WEBHOOK");
      let query = Shipment.find({ waybill, state: "saved" });
      if (typeof query.select === "function") query = query.select("owner state waybill reference record.partnerCode record.carrierCode record.providerCode draftData.selectedPartnerQuote.partnerCode draftData.bookingAttempt.providerReference trackingEvents trackingRevision trackingStatus trackingStatusAt");
      const rows = await (typeof query.lean === "function" ? query.lean() : query);
      const matches = (rows || []).filter(row => {
        if (providerCode !== "DELHIVERY") return true;
        const code = row.record?.partnerCode || row.record?.carrierCode || row.draftData?.selectedPartnerQuote?.partnerCode || row.record?.providerCode;
        const reference = row.draftData?.bookingAttempt?.providerReference || row.reference;
        return code === providerCode && (!normalized.reference || normalized.reference === reference);
      });
      if (matches.length !== 1) {
        return res.status(matches?.length > 1 ? 409 : 404).json({ success: false, code: matches?.length > 1 ? "AMBIGUOUS_SHIPMENT_MATCH" : "SHIPMENT_NOT_FOUND", message: matches?.length > 1 ? "Webhook waybill matches multiple saved shipments; no shipment was updated." : "Webhook waybill does not match a saved shipment." });
      }
      const shipment = matches[0];
      const updated = await appendTrackingEvents({ Shipment, shipment, providerCode: adapter.code, events: normalized.events, source: "WEBHOOK" });
      if (!updated) return res.status(409).json({ success: false, code: "SHIPMENT_CHANGED", message: "Shipment changed while processing the webhook." });
      const archiveKey = createHash("sha256").update(JSON.stringify([String(shipment._id), events.map(event => event.eventKey).sort()])).digest("hex");
      try {
        if (typeof DelhiveryWebhook.init === "function") await DelhiveryWebhook.init();
        await DelhiveryWebhook.updateOne(
          { archiveKey },
          { $setOnInsert: { owner: String(shipment.owner), providerCode: adapter.code, payload } },
          { upsert: true, timestamps: { updatedAt: false } },
        );
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
      return res.status(200).json({ success: true, message: "Webhook received successfully" });
    } catch (error) {
      if (error instanceof TrackingInputError) return res.status(400).json({ success: false, code: "INVALID_WEBHOOK_PAYLOAD", message: error.message });
      return res.status(500).json({ success: false, message: "Webhook processing failed." });
    }
  };
}

module.exports = { createTrackingWebhookController, configuredHeaderAuthenticator, createWebhookEventsController };
