const { isDelhiveryFeatureEnabled } = require("../utils/delhiveryFeatureFlags");
const { mapProviderStatus } = require("./providerStatusMappings");
const { synchronizeShipmentTracking } = require("./shipmentTrackingRouter");
const { randomUUID } = require("node:crypto");
const { requestContext } = require("../utils/requestLogging");

function createTrackingPoller({ Shipment, partnerRegistry, statusMappings, environment = process.env, now = () => new Date(), schedule = setInterval, logger = console }) {
  const minutes = Number(environment.DELHIVERY_TRACKING_POLL_MINUTES || 60);
  const interval = Number.isInteger(minutes) && minutes >= 15 && minutes <= 1440 ? minutes * 60000 : null;
  const enabled = () => interval && environment.DELHIVERY_TRACKING_POLL_ENABLED === "true" &&
    isDelhiveryFeatureEnabled("TRACKING", environment) && typeof partnerRegistry?.get("DELHIVERY")?.track === "function";
  let running = false;

  async function run() {
    if (!enabled() || running) return 0;
    running = true;
    let polled = 0;
    try {
      const at = now();
      const cutoff = new Date(at.getTime() - interval);
      const due = {
        state: "saved",
        waybill: { $regex: /^\d{6,20}$/ },
        "record.mockOnly": { $ne: true },
        updatedAt: { $gte: new Date(at.getTime() - 30 * 86400000) },
        $and: [
          { $or: [{ "record.partnerCode": "DELHIVERY" }, { "record.providerCode": "DELHIVERY" }, { "record.carrierCode": "DELHIVERY" }] },
          { $or: [{ trackingPollAttemptAt: { $lt: cutoff } }, { trackingPollAttemptAt: { $exists: false } }] },
          { $or: [{ trackingStatusAt: { $lt: cutoff } }, { trackingStatusAt: { $exists: false } }] },
        ],
      };
      const rows = await Shipment.find(due).sort({ trackingPollAttemptAt: 1, _id: 1 }).limit(25).lean();
      for (const row of rows) {
        const claim = await Shipment.updateOne({ ...due, _id: row._id, owner: row.owner }, { $set: { trackingPollAttemptAt: at } }, { timestamps: false });
        if (claim.modifiedCount !== 1) continue;
        const current = mapProviderStatus("DELHIVERY", "shipment", row.trackingStatus || row.record?.status, statusMappings);
        if (current === "DELIVERED" || /^cancelled$/i.test(String(row.record?.status || ""))) continue;
        const correlationId = randomUUID();
        try {
          const updated = await requestContext.run({ user: { id: row.owner }, correlationId }, () =>
            synchronizeShipmentTracking({ Shipment, row, partnerRegistry, now, source: "POLL" }));
          if (updated) polled += 1;
        } catch (error) {
          const providerStatus = error?.response?.status;
          logger.warn(JSON.stringify({ event: "tracking.poll", code: "TRACKING_SYNC_FAILED", correlationId,
            ...(Number.isInteger(providerStatus) && providerStatus >= 100 && providerStatus <= 599 ? { providerStatus } : {}) }));
        }
      }
      return polled;
    } finally {
      running = false;
    }
  }

  function start() {
    if (!enabled()) return null;
    const timer = schedule(() => {
      return run().catch(() => logger.warn(JSON.stringify({ event: "tracking.poll", code: "TRACKING_POLL_FAILED" })));
    }, interval);
    timer.unref();
    return timer;
  }
  return { run, start };
}

module.exports = { createTrackingPoller };
