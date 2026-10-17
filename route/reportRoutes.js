const express = require("express");
const mongoose = require("mongoose");
const requireSession = require("../utils/requireSession");
const ScheduledReport = require("../model/scheduledReport");

const router = express.Router();
router.use(requireSession);

const TYPES = ["Orders", "NDR", "Exceptions NDR"];
const RECURRENCES = ["Daily", "Weekly", "Monthly"];
const STATUSES = ["Manifested", "In Transit", "Delivered", "Cancelled"];
const SUB_STATUSES = ["COD", "Prepaid", "Pending Pickup", "RTO"];

function validateReport(body, partial = false) {
  const allowed = ["title", "type", "recipient", "recurrence", "status", "subStatus", "enabled"];
  const errors = [];

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return ["A report object is required."];
  }

  if (Object.keys(body).some(key => !allowed.includes(key))) {
    errors.push("Unsupported report field.");
  }

  if (!partial || Object.hasOwn(body, "title")) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 120) {
      errors.push("Title is required and must be 120 characters or fewer.");
    }
  }

  if ((!partial || Object.hasOwn(body, "type")) && !TYPES.includes(body.type)) {
    errors.push("Invalid report type.");
  }

  if ((!partial || Object.hasOwn(body, "recurrence")) && !RECURRENCES.includes(body.recurrence)) {
    errors.push("Invalid recurrence.");
  }

  if (!partial || Object.hasOwn(body, "recipient")) {
    if (typeof body.recipient !== "string" ||
        body.recipient.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.recipient.trim())) {
      errors.push("Enter a valid recipient email address.");
    }
  }

  for (const [field, values] of [["status", STATUSES], ["subStatus", SUB_STATUSES]]) {
    if ((!partial || Object.hasOwn(body, field)) &&
        (!Array.isArray(body[field]) || body[field].length > values.length ||
         body[field].some(value => !values.includes(value)) ||
         new Set(body[field]).size !== body[field].length)) {
      errors.push("Invalid " + field + " filters.");
    }
  }

  if (Object.hasOwn(body, "enabled") && typeof body.enabled !== "boolean") {
    errors.push("Enabled must be true or false.");
  }

  return errors;
}

function reportData(report) {
  return {
    id: String(report._id),
    title: report.title,
    type: report.type,
    recipient: report.recipient,
    recurrence: report.recurrence,
    status: report.status,
    subStatus: report.subStatus,
    enabled: report.enabled,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  };
}

router.get("/", async (req, res) => {
  try {
    const reports = await ScheduledReport.find({ owner: req.user.id })
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    return res.json({ success: true, data: { reports: reports.map(reportData) } });
  } catch (error) {
    console.error("Reports list failed:", error.message);
    return res.status(503).json({ success: false, message: "Reports could not be loaded." });
  }
});

router.post("/", async (req, res) => {
  const errors = validateReport(req.body);
  if (errors.length) {
    return res.status(400).json({ success: false, message: errors.join(" ") });
  }

  try {
    const report = await ScheduledReport.create({
      owner: req.user.id,
      title: req.body.title.trim(),
      type: req.body.type,
      recipient: req.body.recipient.trim().toLowerCase(),
      recurrence: req.body.recurrence,
      status: req.body.status,
      subStatus: req.body.subStatus,
      enabled: false,
    });

    return res.status(201).json({ success: true, data: { report: reportData(report) } });
  } catch (error) {
    console.error("Report create failed:", error.message);
    return res.status(503).json({ success: false, message: "The report could not be saved." });
  }
});

router.patch("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid report ID." });
  }

  const errors = validateReport(req.body, true);
  if (errors.length) {
    return res.status(400).json({ success: false, message: errors.join(" ") });
  }

  const updates = {};
  for (const field of ["title", "type", "recipient", "recurrence", "status", "subStatus", "enabled"]) {
    if (Object.hasOwn(req.body, field)) updates[field] = req.body[field];
  }
  if (updates.title !== undefined) updates.title = updates.title.trim();
  if (updates.recipient !== undefined) updates.recipient = updates.recipient.trim().toLowerCase();

  try {
    const report = await ScheduledReport.findOneAndUpdate(
      { _id: req.params.id, owner: req.user.id },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!report) {
      return res.status(404).json({ success: false, message: "Report not found." });
    }

    return res.json({ success: true, data: { report: reportData(report) } });
  } catch (error) {
    console.error("Report update failed:", error.message);
    return res.status(503).json({ success: false, message: "The report could not be updated." });
  }
});

router.delete("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid report ID." });
  }

  try {
    const report = await ScheduledReport.findOneAndDelete({
      _id: req.params.id,
      owner: req.user.id,
    });

    if (!report) {
      return res.status(404).json({ success: false, message: "Report not found." });
    }

    return res.json({ success: true, message: "Report deleted." });
  } catch (error) {
    console.error("Report delete failed:", error.message);
    return res.status(503).json({ success: false, message: "The report could not be deleted." });
  }
});

module.exports = router;
