const express = require("express");
const requireSession = require("../utils/requireSession");
const { PartnerCostError, createPartnerCostService } = require("../services/partnerCostService");

function createPartnerCostRoutes({ Shipment, now }) {
  const router = express.Router();
  const costs = createPartnerCostService({ Shipment, now });
  router.use(requireSession);

  const run = handler => async (req, res) => {
    try { return await handler(req, res); }
    catch (error) {
      if (error instanceof PartnerCostError) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
      if (error?.code === 11000) return res.status(409).json({ success: false, code: "FINAL_COST_ALREADY_RECORDED", message: "A final cost for this shipment already exists." });
      return res.status(503).json({ success: false, code: "PARTNER_COST_UNAVAILABLE", message: "Partner cost information could not be retrieved or saved." });
    }
  };

  router.get("/", run(async (req, res) => {
    const allowed = new Set(["UNAVAILABLE", "PENDING", "CONFIRMED", "DISCREPANT"]);
    if (req.query.status && !allowed.has(req.query.status)) return res.status(400).json({ success: false, message: "status must be UNAVAILABLE, PENDING, CONFIRMED, or DISCREPANT." });
    const rows = await costs.list(req.user.id, { partnerCode: req.query.partnerCode, status: req.query.status, from: req.query.from, to: req.query.to });
    return res.json({ success: true, data: { costs: rows } });
  }));

  router.get("/:shipmentId", run(async (req, res) => {
    const cost = await costs.detail(req.user.id, req.params.shipmentId);
    return cost ? res.json({ success: true, data: { cost } }) : res.status(404).json({ success: false, message: "Shipment cost not found." });
  }));

  router.post("/:shipmentId/final", run(async (req, res) => {
    const { amount, currency, sourceReference, invoiceDate, chargeBreakdown, taxBasis, gstRecoverability, notes } = req.body || {};
    const cost = await costs.reconcileFinal({ owner: req.user.id, actor: req.user.id, shipmentId: req.params.shipmentId, amount, currency, sourceReference, invoiceDate, chargeBreakdown, taxBasis, gstRecoverability, notes, correlationId: req.correlationId });
    return res.status(201).json({ success: true, data: { cost } });
  }));

  return router;
}

module.exports = createPartnerCostRoutes;
