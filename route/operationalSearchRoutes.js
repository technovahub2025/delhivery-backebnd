const express = require("express");
const requireSession = require("../utils/requireSession");
const { operationalSearch, DEFAULT_LIMIT } = require("../services/operationalSearchService");
const Shipment = require("../model/appShipment");
const Customer = require("../model/customer");
const Address = require("../model/savedPartyAddress");
const Pickup = require("../model/pickupRequest");
const Ndr = require("../model/ndrCase");
const Rto = require("../model/rtoRecord");

function createOperationalSearchRoutes({ models = { Shipment, Customer, Address, Pickup, Ndr, Rto } } = {}) {
  const router = express.Router();
  router.use(requireSession);
  router.get("/", async (req, res) => {
    try {
      const result = await operationalSearch({ owner: req.user.id, q: req.query.q, page: req.query.page || 1, limit: req.query.limit || DEFAULT_LIMIT, models, permissions: req.authz?.permissions });
      return res.json({ success: true, data: result });
    } catch (error) {
      return res.status(error.status || 503).json({ success: false, message: error.status ? error.message : "Operational search is temporarily unavailable." });
    }
  });
  return router;
}

module.exports = createOperationalSearchRoutes;
module.exports.createOperationalSearchRoutes = createOperationalSearchRoutes;
