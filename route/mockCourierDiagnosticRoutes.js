const express = require("express");
const requireSession = require("../utils/requireSession");

const ALLOWED_ENVIRONMENTS = new Set(["development", "test"]);

function createMockCourierDiagnosticRoutes({
  partnerRegistry,
  mongooseInstance,
  getEnvironment = () => process.env,
} = {}) {
  const router = express.Router();
  const env = getEnvironment() || {};

  // Do not register the route at all in production or any other environment.
  if (!ALLOWED_ENVIRONMENTS.has(String(env.NODE_ENV || "").trim().toLowerCase())) return router;

  router.get("/mock-courier", requireSession, (req, res) => {
    const currentEnv = getEnvironment() || {};
    if (!ALLOWED_ENVIRONMENTS.has(String(currentEnv.NODE_ENV || "").trim().toLowerCase())) {
      return res.status(404).json({ success: false, message: "Not found." });
    }
    const connection = mongooseInstance?.connection;
    const connectionState = Number.isInteger(connection?.readyState) ? connection.readyState : 0;
    let registeredAdapterNames = [];
    try {
      registeredAdapterNames = (partnerRegistry?.list() || []).map(adapter =>
        String(adapter.name || adapter.code || "").trim()
      ).filter(Boolean);
    } catch {
      // A registry error should not expose internals or cause diagnostic failure.
      registeredAdapterNames = [];
    }

    return res.set("Cache-Control", "no-store").json({
      nodeEnv: String(currentEnv.NODE_ENV || ""),
      mockCourierAdapterEnabled: currentEnv.MOCK_COURIER_ADAPTER_ENABLED === "true",
      delhiveryAdapterEnabled: currentEnv.DELHIVERY_SHIPMENT_BOOKING_ENABLED === "true",
      mongoConnectionState: connectionState,
      connectedDatabaseName: connectionState === 1 && typeof connection?.name === "string" ? connection.name : null,
      registeredAdapterNames,
    });
  });

  return router;
}

module.exports = createMockCourierDiagnosticRoutes;
