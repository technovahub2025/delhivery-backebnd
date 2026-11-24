const express = require("express");
const mongoose = require("mongoose");
const requireSession = require("../utils/requireSession");
const { appendTrackingEvents } = require("./shipmentTrackingRouter");
const { persistRtoObservations, appendReturnProgress, publicRto } = require("./rtoService");
const { getDashboardRtoCases, groupRtoShipments, parseDashboardCaseFilters } = require("./dashboardService");

const readQuery = query => query && typeof query.lean === "function" ? query.lean() : query;

function createRtoRouter({ RtoRecord, Shipment, partnerRegistry, statusMappings = {}, now = () => new Date() }) {
  const router = express.Router();
  router.use(requireSession);

  async function ownedRto(owner, id) {
    return readQuery(RtoRecord.findOne({ _id: id, owner }));
  }

  async function linkedShipments(owner, row) {
    const original = await readQuery(Shipment.findOne({ _id: row.originalShipment, owner, waybill: row.originalWaybill, state: "saved" }));
    if (!original) return { original: null, returnShipment: null };
    const returnShipment = row.returnShipment
      ? await readQuery(Shipment.findOne({ _id: row.returnShipment, owner, kind: "reverse", state: "saved" }))
      : null;
    return { original, returnShipment };
  }

  async function materialize(owner) {
    const query = Shipment.find({ owner, state: "saved", $or: [{ kind: "forward" }, { kind: { $exists: false } }] });
    const selected = typeof query.select === "function" ? query.select("owner waybill reference record trackingEvents") : query;
    const shipments = await readQuery(selected);
    let created = 0;
    for (const shipment of shipments || []) created += (await persistRtoObservations({ RtoRecord, shipment, events: shipment.trackingEvents || [], statusMappings, now })).length;
    return { shipments: shipments || [], created };
  }

  router.post("/rto/cases/process", async (req, res) => {
    try {
      const result = await materialize(req.user.id);
      return res.json({ success: true, data: { processedShipments: result.shipments.length, createdOrUpdatedCases: result.created } });
    } catch {
      return res.status(503).json({ success: false, message: "Stored tracking events could not be processed into RTO cases." });
    }
  });

  router.get("/rto/cases", async (req, res) => {
    try {
      const query = RtoRecord.find({ owner: req.user.id });
      const sorted = typeof query.sort === "function" ? query.sort({ occurredAt: -1, _id: -1 }) : query;
      const rows = await readQuery(sorted);
      const cases = [];
      for (const row of rows || []) {
        const { returnShipment } = await linkedShipments(req.user.id, row);
        cases.push(publicRto(row, returnShipment));
      }
      return res.json({ success: true, data: { cases } });
    } catch {
      return res.status(503).json({ success: false, message: "RTO records could not be loaded." });
    }
  });

  router.get("/rto/dashboard-cases", async (req, res) => {
    try {
      const filters = parseDashboardCaseFilters(req.query, ["shipments", "active"]);
      let cases = await getDashboardRtoCases({ Shipment, RtoRecord }, req.user.id, { ...filters, statusMappings });
      if (filters.target === "active") cases = cases.filter(row => row.lifecycleState === "ACTIVE");
      const publicCases = cases.map(row => publicRto(row));
      const shipments = groupRtoShipments(cases).map(group => ({ ...group, cases: group.cases.map(row => publicRto(row)) }));
      return res.json({ success: true, data: { cases: publicCases, shipments, total: filters.target === "active" ? publicCases.length : shipments.length, complete: true, readOnly: true } });
    } catch (error) {
      const status = error instanceof TypeError ? 400 : 503;
      return res.status(status).json({ success: false, message: status === 400 ? error.message : "Dashboard RTO shipments could not be loaded." });
    }
  });

  router.get("/rto/cases/:id", async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid RTO record ID." });
      const row = await ownedRto(req.user.id, req.params.id);
      if (!row) return res.status(404).json({ success: false, message: "RTO record not found." });
      const { original, returnShipment } = await linkedShipments(req.user.id, row);
      if (!original) return res.status(404).json({ success: false, message: "RTO record not found." });
      return res.json({ success: true, data: { rto: publicRto(row, returnShipment), originalShipment: original.record || {}, originalTrackingEvents: original.trackingEvents || [], returnTrackingEvents: returnShipment?.trackingEvents || [] } });
    } catch {
      return res.status(503).json({ success: false, message: "RTO record could not be retrieved." });
    }
  });

  router.post("/rto/cases/:id/return-shipment", async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid RTO record ID." });
      const row = await ownedRto(req.user.id, req.params.id);
      if (!row) return res.status(404).json({ success: false, message: "RTO record not found." });
      const waybill = String(req.body?.waybill || "").trim();
      if (!waybill || waybill.length > 100) return res.status(400).json({ success: false, message: "Enter an existing reverse shipment waybill." });
      const reverseShipment = await readQuery(Shipment.findOne({ owner: req.user.id, state: "saved", kind: "reverse", waybill }));
      if (!reverseShipment) return res.status(404).json({ success: false, message: "No owner-scoped saved reverse shipment matches that waybill." });
      const updated = await readQuery(RtoRecord.findOneAndUpdate(
        { _id: row._id, owner: req.user.id, revision: Number(row.revision || 0) },
        { $set: { returnShipment: reverseShipment._id, revision: Number(row.revision || 0) + 1, updatedAt: now() } },
        { new: true, runValidators: true }
      ));
      if (!updated) return res.status(409).json({ success: false, message: "RTO record changed. Reload and retry." });
      const withProgress = await appendReturnProgress({ RtoRecord, rto: updated, shipment: reverseShipment, statusMappings, now });
      return res.json({ success: true, data: { rto: publicRto(withProgress || updated, reverseShipment) } });
    } catch {
      return res.status(503).json({ success: false, message: "Return shipment could not be linked." });
    }
  });

  router.post("/rto/cases/:id/sync", async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid RTO record ID." });
      const row = await ownedRto(req.user.id, req.params.id);
      if (!row) return res.status(404).json({ success: false, message: "RTO record not found." });
      const { original, returnShipment } = await linkedShipments(req.user.id, row);
      if (!original) return res.status(404).json({ success: false, message: "RTO record not found." });
      const target = returnShipment || original;
      const partnerCode = String(target.record?.partnerCode || target.record?.carrierCode || target.record?.providerCode || original.record?.partnerCode || original.record?.carrierCode || original.record?.providerCode || row.providerCode || "").toUpperCase();
      const adapter = partnerRegistry?.get(partnerCode);
      if (!adapter || typeof adapter.track !== "function") return res.status(409).json({ success: false, code: "RTO_SYNC_UNAVAILABLE", message: "Status synchronization is not configured for this courier." });
      const providerResult = await adapter.track({ waybill: target.waybill, reference: target.reference, shipmentSnapshot: structuredClone(target) });
      const updatedShipment = await appendTrackingEvents({ Shipment, shipment: target, providerCode: adapter.code, events: providerResult?.events, source: "SYNC", now });
      if (!updatedShipment) return res.status(409).json({ success: false, message: "Shipment changed during status synchronization." });
      if (returnShipment) await appendReturnProgress({ RtoRecord, rto: row, shipment: updatedShipment, statusMappings, now });
      else await persistRtoObservations({ RtoRecord, shipment: updatedShipment, events: updatedShipment.trackingEvents || [], statusMappings, now });
      const fresh = await ownedRto(req.user.id, row._id);
      return res.json({ success: true, data: { rto: publicRto(fresh, returnShipment ? updatedShipment : null) } });
    } catch (error) {
      return res.status(error.status || 502).json({ success: false, message: error.status ? error.message : "RTO status synchronization failed." });
    }
  });

  return router;
}

module.exports = { createRtoRouter };
