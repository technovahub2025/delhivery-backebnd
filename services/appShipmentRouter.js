const express = require("express");
const requireSession = require("../utils/requireSession");
function rejected(data) {
  return !data || data.success === false || data.status === false ||
    /^(fail|failed|failure|error)$/i.test(data.status || "") ||
    Boolean(data.error && data.error !== "false") ||
    Boolean(data.errors && Object.keys(data.errors).length);
}
function normalize(input, warehouse, waybill, createdAt) {
  return {
    id: String(waybill), reference: input.order, customer: input.name || "",
    address: input.add || "", destination: input.city || "", state: input.state || "",
    pincode: String(input.pin || ""), phone: String(input.phone || ""), email: input.email || "",
    payment: input.payment_mode || "", value: Number(input.total_amount) || 0,
    weight: (Number(input.weight) || 0) / 1000,
    dimensions: [input.shipment_length, input.shipment_width, input.shipment_height].join(" × "),
    warehouse: warehouse || "", ewaybill: "", date: new Date(createdAt).toISOString().slice(0, 10),
    status: "Pending pickup", history: [],
  };
}
module.exports = function appShipmentRouter({ Shipment, carrier }) {
  const router = express.Router();
  router.get("/shipments", requireSession, async (req, res) => {
    const page = req.query.page ?? "1", limit = req.query.limit ?? "100";
    if (typeof page !== "string" || !/^[1-9]\d*$/.test(page) ||
        typeof limit !== "string" || !/^[1-9]\d*$/.test(limit) || Number(limit) > 100 ||
        !Number.isSafeInteger(Number(page) * Number(limit))) {
      return res.status(400).json({ success: false, message: "page must be a positive integer; limit must be between 1 and 100." });
    }
    try {
      const filter = { owner: req.user.id, state: "saved" };
      const total = await Shipment.countDocuments(filter);
      const rows = await Shipment.find(filter).sort({ createdAt: -1, _id: -1 })
        .skip((Number(page) - 1) * Number(limit)).limit(Number(limit)).lean();
      return res.json({ success: true, data: {
        shipments: rows.map(row => row.record), total, page: Number(page), limit: Number(limit),
        source: "app-created",
      } });
    } catch {
      return res.status(503).json({ success: false, message: "Saved shipments could not be loaded. Check the backend database connection and retry." });
    }
  });
  router.post("/shipments", requireSession, async (req, res) => {
    const input = req.body?.shipments?.[0];
    if (!Array.isArray(req.body?.shipments) || req.body.shipments.length !== 1 ||
        typeof input?.order !== "string" || !input.order.trim()) {
      return res.status(400).json({ success: false, message: "Submit one shipment with a unique order reference." });
    }
    let intent;
    try {
      await Shipment.init();
      const previous = await Shipment.findOne({ owner: req.user.id, reference: input.order });
      if (previous) {
        if (previous.state === "saved") return res.json({ success: true, data: previous.receipt, shipment: previous.record });
        return res.status(409).json({ success: false, message: "This order has a pending or uncertain creation result. Check it in Delhivery before resubmitting; do not use a new reference to retry." });
      }
      intent = await Shipment.create({ owner: req.user.id, reference: input.order, state: "creating" });
    } catch (error) {
      return res.status(error.code === 11000 ? 409 : 503).json({ success: false, message: "The order could not be reserved. It may already be processing, or the database is unavailable. No new carrier request was sent." });
    }
    let data;
    try {
      const response = await carrier.post("/api/cmu/create.json",
        `format=json&data=${encodeURIComponent(JSON.stringify(req.body))}`,
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      data = response.data;
    } catch {
      return res.status(502).json({ success: false, message: "Delhivery did not confirm creation. This order may have been created. Check the order in Delhivery before retrying." });
    }
    const parcel = data?.packages?.[0];
    const waybill = parcel?.waybill || parcel?.wbn || parcel?.AWB;
    if (rejected(data) || rejected(parcel) || !waybill) {
      const uncertain = /partially\s+saved|might\s+have\s+been|may\s+have\s+been|internal\s+error|crashing\s+while\s+saving/i.test(JSON.stringify(data));
      // Retain reservations for ambiguous responses; only explicit rejection is safe to retry.
      if (!uncertain && !waybill && (data?.success === false || /^(fail|failed|error)$/i.test(parcel?.status || ""))) {
        try { await Shipment.deleteOne({ _id: intent._id, state: "creating" }); } catch { /* retain reservation */ }
      }
      const remarks = Array.isArray(parcel?.remarks) ? parcel.remarks.join(" ") : parcel?.remarks;
      const insufficientBalance = /insufficient\s+balance/i.test(String(remarks || ""));
      const message = insufficientBalance
        ? "Delhivery reported insufficient balance in the prepaid carrier account. Recharge the Delhivery account or contact your account administrator. " +
          (uncertain
            ? "The package might have been partially saved. Check this order in Delhivery or contact support before retrying; do not submit it with a new reference."
            : "Check the order in Delhivery before retrying.")
        : "Delhivery did not confirm an accepted shipment. Check the order before retrying.";
      return res.status(502).json({ success: false, message, data });
    }
    const record = normalize(input, req.body.pickup_location?.name, waybill, intent.createdAt);
    const receipt = { success: true, packages: [{ waybill: String(waybill), status: "Success" }] };
    try {
      await Shipment.updateOne({ _id: intent._id }, { $set: { state: "saved", waybill: String(waybill), record, receipt } });
    } catch {
      return res.status(503).json({ success: false, code: "SHIPMENT_SAVE_FAILED", waybill: String(waybill),
        message: `Delhivery created waybill ${waybill}, but saving it failed. Do not create it again. Contact support with this waybill and order reference.` });
    }
    return res.status(201).json({ success: true, data: receipt, shipment: record });
  });
  for (const action of ["update", "cancel", "ewaybill"]) {
    router.post(`/shipments/${action}`, requireSession, async (req, res) => {
      const waybill = req.body?.waybill;
      if (typeof waybill !== "string" || !waybill) return res.status(400).json({ success: false, message: "Waybill is required." });
      try {
        const saved = await Shipment.findOne({ owner: req.user.id, waybill, state: "saved" });
        if (!saved) return res.status(404).json({ success: false, message: "Shipment not found for your login." });
        const body = { waybill };
        const allowed = action === "ewaybill" ? ["ewbn"] : ["name", "add", "phone", "pin", "city"];
        for (const key of allowed) if (req.body[key] !== undefined) body[key] = req.body[key];
        if (action === "cancel") body.status = "Cancelled";
        const { data } = await carrier.post("/api/p/edit", body);
        if (rejected(data)) return res.status(502).json({ success: false, message: "Delhivery rejected the update.", data });
        const changes = {};
        if (action === "cancel") changes["record.status"] = "Cancelled";
        for (const [key, field] of Object.entries({ name: "customer", add: "address", phone: "phone", pin: "pincode", city: "destination", ewbn: "ewaybill" })) {
          if (body[key] !== undefined) changes[`record.${field}`] = body[key];
        }
        try { await Shipment.updateOne({ _id: saved._id }, { $set: changes }); }
        catch { return res.status(503).json({ success: false, message: "Delhivery accepted the update but saving it failed. Check the shipment before retrying." }); }
        return res.json({ success: true, data });
      } catch {
        return res.status(503).json({ success: false, message: "Shipment update could not be confirmed. Check its status before retrying." });
      }
    });
  }
  return router;
};
