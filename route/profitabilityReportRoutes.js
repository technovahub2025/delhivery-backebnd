const express = require("express");
const requireSession = require("../utils/requireSession");
const { ProfitabilityReportError, createProfitabilityReportService } = require("../services/profitabilityReportService");
const { generateXlsx, generatePdf } = require("../services/financialReportExportService");

module.exports = function createProfitabilityReportRoutes({ Shipment, Invoice }) {
  const router = express.Router();
  const reports = createProfitabilityReportService({ Shipment, Invoice });
  router.use(requireSession);
  router.get("/profitability", async (req, res) => {
    try {
      const result = await reports.run(req.user.id, req.query);
      return res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof ProfitabilityReportError) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
      return res.status(503).json({ success: false, code: "PROFITABILITY_UNAVAILABLE", message: "Profitability reports could not be loaded." });
    }
  });
  router.get("/profitability/export.xlsx", async (req, res) => {
    try {
      const result = await reports.run(req.user.id, req.query);
      const file = generateXlsx(result);
      const label = String(result.period?.label || "range").replace(/[^a-zA-Z0-9_-]/g, "-");
      res.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="profitability-${label}.xlsx"`, "Cache-Control": "no-store", "Content-Length": String(file.length) });
      return res.send(file);
    } catch (error) {
      if (error instanceof ProfitabilityReportError) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
      return res.status(503).json({ success: false, code: "PROFITABILITY_EXPORT_UNAVAILABLE", message: "Excel profitability export could not be generated." });
    }
  });
  router.get("/profitability/export.pdf", async (req, res) => {
    try {
      const result = await reports.run(req.user.id, req.query);
      const file = generatePdf(result);
      const label = String(result.period?.label || "range").replace(/[^a-zA-Z0-9_-]/g, "-");
      res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="profitability-${label}.pdf"`, "Cache-Control": "no-store", "Content-Length": String(file.length) });
      return res.send(file);
    } catch (error) {
      if (error instanceof ProfitabilityReportError) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
      return res.status(503).json({ success: false, code: "PROFITABILITY_EXPORT_UNAVAILABLE", message: "PDF profitability export could not be generated." });
    }
  });
  return router;
};
