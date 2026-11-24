const express = require("express");
const mongoose = require("mongoose");
const requireSession = require("../utils/requireSession");

function createPickupDiagnosticRoutes({ PickupRequest }) {
  const router = express.Router();
  router.use(requireSession);
  router.get("/:id", async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid pickup request ID." });
    try {
      const row = await PickupRequest.findOne({ _id: req.params.id, owner: req.user.id }).select("workflow status carrierSubmissionStatus submissionAttempt history").lean();
      if (!row) return res.status(404).json({ success: false, message: "Pickup request not found." });
      const evidence = row.submissionAttempt || {};
      const eligible = row.carrierSubmissionStatus === "FAILED" && (evidence.providerDispatched === false || (evidence.providerDispatched === true && evidence.providerOutcome === "REJECTED" && evidence.providerResponse));
      const reason = eligible ? "Verified pre-dispatch failure or explicit provider rejection." : row.carrierSubmissionStatus === "SUBMITTING" ? "Submission is still in progress." : row.carrierSubmissionStatus === "OUTCOME_UNCONFIRMED" ? "Provider outcome is uncertain and requires reconciliation." : "Sufficient safe-recovery evidence is missing.";
      return res.json({ success: true, data: { pickup: { workflow: row.workflow, status: row.status, carrierSubmissionStatus: row.carrierSubmissionStatus || null, submissionAttempt: evidence, history: (row.history || []).filter(item => String(item.action || "").startsWith("CARRIER_")) }, recovery: { eligible, reason } } });
    } catch { return res.status(503).json({ success: false, message: "Pickup diagnostic could not be loaded." }); }
  });
  return router;
}

module.exports = createPickupDiagnosticRoutes;
