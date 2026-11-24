const express = require("express");
const requireSession = require("../utils/requireSession");
const BusinessAuditEvent = require("../model/businessAuditEvent");
const DelhiveryIntegrationEvent = require("../model/delhiveryIntegrationEvent");

function createBusinessAuditRoutes({ AuditModel = BusinessAuditEvent, IntegrationModel = DelhiveryIntegrationEvent } = {}) {
  const router = express.Router();
  router.use(requireSession);
  const listEvents = ({ Model, projection, serialize, failure }) => async (req, res) => {
    const pageText = req.query.page ?? "1";
    const limitText = req.query.limit ?? "50";
    if (typeof pageText !== "string" || typeof limitText !== "string" ||
        !/^[1-9]\d*$/.test(pageText) || !/^[1-9]\d*$/.test(limitText) || Number(pageText) > 1000 || Number(limitText) > 100) {
      return res.status(400).json({ success: false, message: "page must be 1–1000 and limit must be 1–100." });
    }
    try {
      const query = Model.find({ ownerId: req.user.id });
      const limit = Number(limitText);
      const page = Number(pageText);
      const rows = await query.sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit + 1).select(projection).lean();
      return res.json({ success: true, data: { events: rows.slice(0, limit).map(serialize), page, limit, hasMore: page < 1000 && rows.length > limit } });
    } catch {
      return res.status(503).json({ success: false, message: failure });
    }
  };
  router.get("/", listEvents({
    Model: AuditModel,
    projection: "actorId action entityType entityRef outcome statusCode changedFields correlationId createdAt",
    serialize: row => ({ id: String(row._id), actorId: row.actorId, action: row.action, entityType: row.entityType,
      entityRef: row.entityRef || null, outcome: row.outcome, statusCode: row.statusCode, changedFields: row.changedFields || [],
      correlationId: row.correlationId || null, createdAt: row.createdAt }),
    failure: "Business audit history could not be loaded.",
  }));
  router.get("/integrations", listEvents({
    Model: IntegrationModel,
    projection: "method operationPath statusCode outcome durationMs correlationId createdAt",
    serialize: row => ({ id: String(row._id), method: row.method, operationPath: row.operationPath,
      statusCode: row.statusCode ?? null, outcome: row.outcome, durationMs: row.durationMs,
      correlationId: row.correlationId || null, createdAt: row.createdAt }),
    failure: "Carrier integration history could not be loaded.",
  }));
  return router;
}

module.exports = createBusinessAuditRoutes;
module.exports.createBusinessAuditRoutes = createBusinessAuditRoutes;
