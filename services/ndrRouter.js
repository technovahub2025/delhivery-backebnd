const express = require("express");
const mongoose = require("mongoose");
const requireSession = require("../utils/requireSession");
const { persistNdrObservations, publicCase, actionRecord, actionHistory } = require("./ndrService");
const { getDashboardNdrCases, groupNdrShipments, parseDashboardCaseFilters } = require("./dashboardService");
const { withSafeReadRetry, singleFlight } = require("../utils/safeReadRetry");

const ACTIONS = new Set(["RE-ATTEMPT", "PICKUP_RESCHEDULE", "CUSTOMER_CONTACT", "DELIVERY_INSTRUCTIONS", "MARK_RESOLVED"]);
const CARRIER_ACTIONS = new Set(["RE-ATTEMPT", "PICKUP_RESCHEDULE"]);
const BLOCKING_CASE_STATES = new Set(["ACTION_SUBMITTING", "OUTCOME_UNCONFIRMED", "RESOLVED"]);
const clone = value => structuredClone(value);
const readQuery = query => query && typeof query.lean === "function" ? query.lean() : query;

function findAdapter(registry, providerCode) { return registry?.get(String(providerCode || "").trim().toUpperCase()) || null; }

function createNdrRouter({ NdrCase, Shipment, partnerRegistry, statusMappings = {}, now = () => new Date() }) {
  const router = express.Router();
  router.use(requireSession);

  async function materializeFromTracking(owner) {
    const query = Shipment.find({ owner, state: "saved", $or: [{ kind: "forward" }, { kind: { $exists: false } }] });
    const shipments = await (typeof query.select === "function" ? query.select("owner waybill reference record trackingEvents") : query);
    const rows = await readQuery(shipments);
    let created = 0;
    for (const shipment of rows || []) created += (await persistNdrObservations({ NdrCase, shipment, events: shipment.trackingEvents || [], now })).length;
    return { shipments: rows || [], created };
  }

  async function getOwnedCase(owner, id) {
    return readQuery(NdrCase.findOne({ _id: id, owner }));
  }

  async function submitAction(caseRow, owner, action, details) {
    if (!ACTIONS.has(action)) return { status: 400, body: { success: false, message: "Unsupported NDR action." } };
    if (["CUSTOMER_CONTACT", "DELIVERY_INSTRUCTIONS", "MARK_RESOLVED"].includes(action) && !details.trim()) return { status: 400, body: { success: false, message: "Action details are required." } };
    const shipment = await readQuery(Shipment.findOne({ _id: caseRow.shipment, owner, waybill: caseRow.waybill, state: "saved" }));
    if (!shipment) return { status: 404, body: { success: false, message: "Shipment not found." } };
    if (BLOCKING_CASE_STATES.has(caseRow.status) || (CARRIER_ACTIONS.has(action) && caseRow.status === "ACTION_SUBMITTED")) return { status: 409, body: { success: false, code: "NDR_ACTION_ALREADY_PENDING", message: "This NDR case already has a pending or completed carrier action." } };

    const timestamp = now();
    if (!CARRIER_ACTIONS.has(action)) {
      const resolves = action === "MARK_RESOLVED";
      const entry = actionRecord({ action, details, now: timestamp, status: resolves ? "RESOLVED" : "RECORDED" });
      const saved = await NdrCase.findOneAndUpdate(
        { _id: caseRow._id, owner, revision: Number(caseRow.revision || 0), status: caseRow.status },
        { $set: { actions: [...actionHistory(caseRow), entry], ...(resolves ? { status: "RESOLVED", resolvedAt: timestamp } : {}), revision: Number(caseRow.revision || 0) + 1, updatedAt: timestamp } },
        { new: true, runValidators: true }
      );
      const result = await readQuery(saved);
      if (!result) return { status: 409, body: { success: false, message: "NDR case changed. Reload and retry." } };
      return { status: 200, body: { success: true, message: resolves ? "NDR case marked resolved." : "NDR action recorded for operations follow-up.", data: { case: publicCase(result), action: entry } } };
    }

    const adapter = findAdapter(partnerRegistry, caseRow.providerCode || shipment.record?.partnerCode);
    if (!adapter || typeof adapter.ndrAction !== "function") {
      const entry = actionRecord({ action, details, now: timestamp, status: "UNAVAILABLE", error: "Carrier action is not configured for this courier." });
      const saved = await NdrCase.findOneAndUpdate(
        { _id: caseRow._id, owner, revision: Number(caseRow.revision || 0), status: caseRow.status },
        { $set: { actions: [...actionHistory(caseRow), entry], revision: Number(caseRow.revision || 0) + 1, updatedAt: timestamp } },
        { new: true, runValidators: true }
      );
      if (!await readQuery(saved)) return { status: 409, body: { success: false, message: "NDR case changed. Reload and retry." } };
      return { status: 409, body: { success: false, code: "NDR_ACTION_UNAVAILABLE", message: "This carrier action is not configured.", data: { action: entry } } };
    }

    const claim = actionRecord({ action, details, now: timestamp, status: "SUBMITTING" });
    const claimed = await readQuery(NdrCase.findOneAndUpdate(
      { _id: caseRow._id, owner, revision: Number(caseRow.revision || 0), status: caseRow.status },
      { $set: { status: "ACTION_SUBMITTING", actions: [...actionHistory(caseRow), claim], revision: Number(caseRow.revision || 0) + 1, updatedAt: timestamp } },
      { new: true, runValidators: true }
    ));
    if (!claimed) return { status: 409, body: { success: false, message: "NDR case changed. Reload and retry." } };

    try {
      const providerResult = await adapter.ndrAction({ waybill: caseRow.waybill, action, details, caseSnapshot: clone(publicCase(claimed)) });
      const finalAction = { ...claim, status: providerResult?.resolved === true ? "SUCCEEDED" : "SUBMITTED", ...(providerResult?.providerRequestId && { providerRequestId: String(providerResult.providerRequestId) }), result: providerResult?.responseSnapshot ?? null, completedAt: now().toISOString() };
      const caseStatus = providerResult?.resolved === true ? "RESOLVED" : "ACTION_SUBMITTED";
      const saved = await readQuery(NdrCase.findOneAndUpdate(
        { _id: caseRow._id, owner, revision: Number(claimed.revision || 0), status: "ACTION_SUBMITTING" },
        { $set: { status: caseStatus, actions: [...actionHistory(claimed).slice(0, -1), finalAction], revision: Number(claimed.revision || 0) + 1, ...(caseStatus === "RESOLVED" ? { resolvedAt: now() } : {}), updatedAt: now() } },
        { new: true, runValidators: true }
      ));
      if (!saved) return { status: 503, body: { success: false, code: "NDR_ACTION_OUTCOME_UNCONFIRMED", message: "The carrier returned a response but the action status could not be saved. Do not submit it again." } };
      return { status: 200, body: { success: true, message: "NDR action submitted. Carrier processing is not confirmed by submission alone.", data: { case: publicCase(saved), action: finalAction } } };
    } catch (error) {
      const outcome = error?.definitive === true ? "ACTION_FAILED" : "OUTCOME_UNCONFIRMED";
      const finalAction = { ...claim, status: outcome, error: outcome === "ACTION_FAILED" ? "Carrier rejected the action." : "Carrier action outcome is unconfirmed.", completedAt: now().toISOString() };
      await readQuery(NdrCase.findOneAndUpdate(
        { _id: caseRow._id, owner, revision: Number(claimed.revision || 0), status: "ACTION_SUBMITTING" },
        { $set: { status: outcome, actions: [...actionHistory(claimed).slice(0, -1), finalAction], revision: Number(claimed.revision || 0) + 1, updatedAt: now() } },
        { new: true, runValidators: true }
      ));
      return { status: outcome === "ACTION_FAILED" ? 422 : 502, body: { success: false, code: outcome, message: outcome === "ACTION_FAILED" ? "The carrier rejected the NDR action." : "The carrier action outcome is unconfirmed. Do not submit again." } };
    }
  }

  router.post("/ndr/cases/process", async (req, res) => {
    try {
      const result = await materializeFromTracking(req.user.id);
      return res.json({ success: true, data: { processedShipments: result.shipments.length, createdCases: result.created } });
    } catch {
      return res.status(503).json({ success: false, message: "Stored tracking events could not be processed into NDR cases." });
    }
  });

  router.get("/ndr/cases", async (req, res) => {
    try {
      const query = NdrCase.find({ owner: req.user.id });
      const sorted = typeof query.sort === "function" ? query.sort({ occurredAt: -1, _id: -1 }) : query;
      const rows = await readQuery(sorted);
      return res.json({ success: true, data: { cases: (rows || []).map(publicCase), complete: true } });
    } catch {
      return res.status(503).json({ success: false, message: "NDR cases could not be loaded." });
    }
  });

  router.get("/ndr/dashboard-cases", async (req, res) => {
    try {
      const filters = parseDashboardCaseFilters(req.query, ["shipments"]);
      const cases = await getDashboardNdrCases({ Shipment, NdrCase }, req.user.id, { ...filters, statusMappings });
      const shipments = groupNdrShipments(cases).map(group => ({ ...group, cases: group.cases.map(publicCase) }));
      return res.json({ success: true, data: { shipments, total: shipments.length, complete: true, readOnly: true } });
    } catch (error) {
      const status = error instanceof TypeError ? 400 : 503;
      return res.status(status).json({ success: false, message: status === 400 ? error.message : "Dashboard NDR shipments could not be loaded." });
    }
  });

  router.get("/ndr/cases/:id", async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid NDR case ID." });
      const row = await getOwnedCase(req.user.id, req.params.id);
      if (!row) return res.status(404).json({ success: false, message: "NDR case not found." });
      const shipment = await readQuery(Shipment.findOne({ _id: row.shipment, owner: req.user.id, waybill: row.waybill, state: "saved" }));
      if (!shipment) return res.status(404).json({ success: false, message: "NDR case not found." });
      return res.json({ success: true, data: { case: publicCase(row), trackingEvents: shipment.trackingEvents || [] } });
    } catch {
      return res.status(503).json({ success: false, message: "NDR case could not be retrieved." });
    }
  });

  router.post("/ndr/cases/:id/actions", async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid NDR case ID." });
      const row = await getOwnedCase(req.user.id, req.params.id);
      if (!row) return res.status(404).json({ success: false, message: "NDR case not found." });
      const action = String(req.body?.action || "").trim().toUpperCase();
      if (req.body?.details !== undefined && typeof req.body.details !== "string") return res.status(400).json({ success: false, message: "Action details must be text." });
      const details = String(req.body?.details || "").trim();
      if (details.length > 1000) return res.status(400).json({ success: false, message: "Action details are too long." });
      const result = await submitAction(row, req.user.id, action, details);
      return res.status(result.status).json(result.body);
    } catch {
      return res.status(503).json({ success: false, message: "NDR action could not be processed." });
    }
  });

  // Backward-compatible legacy path; it now verifies the owner’s saved shipment and persistent case.
  router.post("/ndr/update", async (req, res) => {
    try {
      const waybill = String(req.body?.waybill || "").trim();
      const action = String(req.body?.act || "").trim().toUpperCase();
      if (!waybill || waybill.length > 80 || !CARRIER_ACTIONS.has(action)) return res.status(400).json({ success: false, message: "A valid waybill and supported action are required." });
      const row = await readQuery(NdrCase.findOne({ owner: req.user.id, waybill, status: { $nin: ["RESOLVED", "ACTION_SUBMITTING", "ACTION_SUBMITTED", "OUTCOME_UNCONFIRMED"] } }));
      if (!row) return res.status(404).json({ success: false, message: "No owner-scoped NDR case exists for this waybill." });
      const result = await submitAction(row, req.user.id, action, "");
      return res.status(result.status).json(result.body);
    } catch {
      return res.status(503).json({ success: false, message: "NDR action could not be processed." });
    }
  });

  router.get("/ndr/status/:uplId", async (req, res) => {
    try {
      const uplId = String(req.params.uplId || "").trim();
      if (!/^UPL[A-Za-z0-9_-]{1,100}$/.test(uplId)) return res.status(400).json({ success: false, message: "A valid UPL ID is required." });
      const row = await readQuery(NdrCase.findOne({ owner: req.user.id, "actions.providerRequestId": uplId }));
      if (!row) return res.status(404).json({ success: false, message: "NDR request not found." });
      const shipment = await readQuery(Shipment.findOne({ _id: row.shipment, owner: req.user.id, waybill: row.waybill, state: "saved" }));
      if (!shipment) return res.status(404).json({ success: false, message: "NDR request not found." });
      const adapter = findAdapter(partnerRegistry, row.providerCode || shipment.record?.partnerCode);
      if (!adapter || typeof adapter.ndrStatus !== "function") return res.status(409).json({ success: false, code: "NDR_STATUS_UNAVAILABLE", message: "Carrier NDR status checks are not configured." });
      await singleFlight(`ndr-status:${req.user.id}:${uplId}:${row.waybill}`, () => withSafeReadRetry(() => adapter.ndrStatus({ uplId, waybill: row.waybill }), { policy: "providerRead" }));
      // An upload can include multiple shipments. The provider's per-AWB response
      // contract is unverified, so do not return the batch or infer a case transition.
      return res.json({
        success: true,
        message: "The carrier upload was checked. The result for this waybill remains unconfirmed.",
        data: { providerRequestId: uplId, waybill: row.waybill, status: "UNCONFIRMED" },
      });
    } catch {
      return res.status(502).json({ success: false, message: "NDR status could not be retrieved." });
    }
  });

  return router;
}

module.exports = { ACTIONS, createNdrRouter };
