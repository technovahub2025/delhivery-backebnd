const express = require("express");
const requireSession = require("../utils/requireSession");
const { isDelhiveryFeatureEnabled } = require("../utils/delhiveryFeatureFlags");

module.exports = function createDirectBookingConfigurationRoutes({ getEnvironment = () => process.env } = {}) {
  const router = express.Router();

  router.get("/direct-booking", requireSession, (req, res) => {
    const env = getEnvironment() || {};
    return res.json({ directBookingEnabled: isDelhiveryFeatureEnabled("SHIPMENT_BOOKING", env) });
  });

  return router;
};
