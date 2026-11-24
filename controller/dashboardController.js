const requireSession = require("../utils/requireSession");
const { getDashboardOverview } = require("../services/dashboardService");
const { mapProviderStatus } = require("../services/providerStatusMappings");

function parseDateRange(query) {
  const parse = (value, end = false) => {
    if (!value) return null;
    const text = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("Date filters must use YYYY-MM-DD.");
    const date = new Date(`${text}T${end ? "00:00:00.000" : "00:00:00.000"}Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error("Date filters must use valid calendar dates.");
    if (end) date.setUTCDate(date.getUTCDate() + 1);
    return date;
  };
  const from = parse(query.from);
  const to = parse(query.to, true);
  if (from && to && from >= to) throw new Error("The end date must be on or after the start date.");
  return { from, to };
}

module.exports = function createDashboardController({ Shipment, PickupRequest, NdrCase, RtoRecord, statusMappings = {} }) {
  return {
    getOverview: [requireSession, async (req, res) => {
      try {
        const { from, to } = parseDateRange(req.query);
        const status = String(req.query.status || "").trim();
        const allowed = new Set(["inTransit", "delivered", "failedException", "rtoInTransit", "other", "unknown"]);
        if (status && !allowed.has(status)) return res.status(400).json({ success: false, message: "Unsupported shipment status filter." });
        const data = await getDashboardOverview({ Shipment, PickupRequest, NdrCase, RtoRecord }, req.user.id, { from, to, status, statusMappings });
        return res.json({ success: true, data });
      } catch (error) {
        if (/Date filters|end date/.test(error.message)) return res.status(400).json({ success: false, message: error.message });
        return res.status(503).json({ success: false, message: "Operations summary could not be loaded." });
      }
    }],
    // Keep the old response envelope while reading stored tracking history only.
    getActionRequired: [requireSession, async (req, res) => {
      try {
        const owner = req.user.id;
        const rows = await Shipment.find({ owner, state: "saved", $or: [{ kind: "forward" }, { kind: { $exists: false } }] }).select("trackingEvents reference record.partnerCode record.providerCode").lean();
        const badAddresses = rows.filter(row => (row.trackingEvents || []).some(event => /bad\/?incomplete address/i.test(`${event.status || ""} ${event.description || ""}`))).length;
        const requested = new Set(String(process.env.OPERATIONAL_NOTIFICATION_TYPES || "").split(",").map(value => value.trim().toUpperCase()));
        const labels = { FAILED: "Delivery failed", EXCEPTION: "Transit exception", DELAYED: "Delivery delayed", LOST: "Shipment lost", DAMAGED: "Shipment damaged", NDR: "Non-delivery report", RTO: "Return to origin", PICKUP_FAILED: "Pickup failed" };
        const notices = [];
        for (const row of rows) for (const event of row.trackingEvents || []) {
          const provider = event.providerCode || row.record?.partnerCode || row.record?.providerCode;
          const kind = mapProviderStatus(provider, "shipment", event.status, statusMappings);
          if (!labels[kind] || !requested.has(kind) || !event.eventKey) continue;
          notices.push({ id: `${row._id}:${event.eventKey}`, title: labels[kind], reference: row.reference, at: event.occurredAt });
        }
        if (requested.has("PICKUP_FAILED")) {
          const pickups = await PickupRequest.find({ owner, status: "Failed" }).select("warehouse updatedAt").sort({ updatedAt: -1 }).limit(20).lean();
          for (const pickup of pickups) notices.push({ id: String(pickup._id), title: labels.PICKUP_FAILED, reference: pickup.warehouse, at: pickup.updatedAt });
        }
        const notifications = notices.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 20);
        return res.json({ success: true, data: { badAddresses, badAddressesAvailable: true, trackingChecked: rows.length, trackingFailed: 0, message: "Stored tracking history checked; no live carrier request was made.", highRiskOrders: null, pending: null, toBeShipped: null, exceptionsNdr: null, notifications } });
      } catch {
        return res.status(503).json({ success: false, message: "Action Required information could not be loaded. Please try again." });
      }
    }],
  };
};

module.exports.parseDateRange = parseDateRange;
