const carrier = require("../services/delhiveryService");
const Allocation = require("../model/waybillAllocation");
const { isDelhiveryFeatureEnabled, delhiveryFeatureDisabledResponse } = require("../utils/delhiveryFeatureFlags");

const validKey = value => typeof value === "string" && /^[a-z0-9-]{16,100}$/i.test(value);

function serialize(row) {
  return { requestId: row.requestId, count: row.count, state: row.state,
    ...(row.state === "CONFIRMED" ? { waybills: row.waybills } : {}) };
}

exports.getWaybillAllocation = async (req, res) => {
  if (!validKey(req.params.requestId)) return res.status(400).json({ success: false, message: "Invalid allocation request ID." });
  try {
    const row = await Allocation.findOne({ owner: req.user.id, requestId: req.params.requestId }).lean();
    return row ? res.json({ success: true, data: serialize(row) }) :
      res.status(404).json({ success: false, code: "WAYBILL_ALLOCATION_NOT_FOUND", message: "Allocation request not found." });
  } catch {
    return res.status(503).json({ success: false, message: "Allocation status could not be loaded." });
  }
};

exports.fetchWaybill = async (req, res) => {
  const { count = 1, requestId } = req.body || {};
  if (!["string", "number"].includes(typeof count) || !/^\d+$/.test(String(count)) || Number(count) < 1 || Number(count) > 10000) {
    return res.status(400).json({ success: false, message: "count must be an integer between 1 and 10000" });
  }
  if (!isDelhiveryFeatureEnabled("WAYBILL_ALLOCATION")) return delhiveryFeatureDisabledResponse(res, "WAYBILL_ALLOCATION");
  if (!validKey(requestId)) return res.status(400).json({ success: false, message: "A valid allocation request ID is required." });
  const key = { owner: req.user.id, requestId };
  const quantity = Number(count);
  let reservation;
  try {
    await Allocation.init();
    try { reservation = await Allocation.create({ ...key, count: quantity, state: "PENDING" }); }
    catch (error) {
      if (error?.code !== 11000) throw error;
      const existing = await Allocation.findOne(key).lean();
      if (!existing) throw error;
      if (quantity !== existing.count) return res.status(409).json({ success: false, code: "WAYBILL_ALLOCATION_KEY_CONFLICT", message: "This request ID was already used with a different count." });
      return res.json({ success: true, data: serialize(existing) });
    }
  } catch {
    return res.status(503).json({ success: false, message: "The allocation could not be reserved. No carrier request was sent." });
  }
  const reserved = { ...key, _id: reservation._id, state: "PENDING" };
  try {
    const response = await carrier.get("/waybill/api/bulk/json/", { params: { count: quantity } });
    let values = response.data?.waybills ?? response.data?.waybill ?? response.data;
    if (typeof values === "string") values = values.trim().split(/[,\s]+/);
    const waybills = Array.isArray(values) ? values.map(value =>
      (typeof value === "string" || Number.isSafeInteger(value)) && /^\d{6,20}$/.test(String(value)) ? String(value) : "") : [];
    if (response.data?.success === false || waybills.length !== quantity || waybills.includes("") || new Set(waybills).size !== waybills.length) {
      throw new Error("The complete allocation was not confirmed.");
    }
    const stored = await Allocation.updateOne(reserved, { $set: { state: "CONFIRMED", waybills } });
    if (stored.modifiedCount !== 1) throw new Error("The allocation could not be saved.");
    return res.json({ success: true, data: serialize({ requestId, count: quantity, state: "CONFIRMED", waybills }) });
  } catch (error) {
    const notSent = error?.code === "DELHIVERY_CONFIGURATION_ERROR";
    try { await Allocation.updateOne(reserved, { $set: { state: notSent ? "NOT_SENT" : "UNCONFIRMED" } }); }
    catch { /* A pending reservation still prevents the operation from being sent again. */ }
    return res.status(notSent ? 503 : 502).json({ success: false, requestId,
      code: notSent ? "DELHIVERY_CONFIGURATION_ERROR" : "WAYBILL_ALLOCATION_UNCONFIRMED",
      message: notSent ? "Delhivery allocation is not configured. No carrier request was sent." :
        "The carrier allocation could not be confirmed and saved. Check this allocation before requesting more waybills." });
  }
};
