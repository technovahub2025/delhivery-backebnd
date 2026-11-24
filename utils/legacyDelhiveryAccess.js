const Shipment = require("../model/appShipment");

function readQuery(query) {
  return query && typeof query.lean === "function" ? query.lean() : query;
}

function parseWaybills(value) {
  if (typeof value !== "string") return null;
  const values = value.split(",").map(part => part.trim());
  if (!values.length || values.length > 50 || values.some(part => !/^\d{6,20}$/.test(part))) return null;
  return [...new Set(values)];
}

function requireOwnedShipment(ShipmentModel = Shipment) {
  return async (req, res, next) => {
    const waybills = parseWaybills(req.query.waybill);
    if (!waybills) return res.status(400).json({ success: false, message: "Provide a valid waybill." });
    try {
      const rows = await readQuery(ShipmentModel.find({ owner: req.user.id, state: "saved", waybill: { $in: waybills } }));
      const owned = new Set((rows || []).map(row => String(row.waybill)));
      if (waybills.some(waybill => !owned.has(waybill))) {
        return res.status(404).json({ success: false, message: "Shipment not found for your login." });
      }
      req.ownedWaybills = waybills;
      return next();
    } catch {
      return res.status(503).json({ success: false, message: "Shipment ownership could not be verified." });
    }
  };
}

module.exports = { parseWaybills, requireOwnedShipment };
