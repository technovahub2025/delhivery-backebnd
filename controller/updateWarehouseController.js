const delhiveryApi = require("../services/delhiveryService");
const Warehouse = require("../model/delhiveryWarehouse");
const { validateWarehouse, warehouseKey, safeProviderSnapshot, warehouseView, failureState } = require("./createWarehouseController");
const { isDelhiveryFeatureEnabled, delhiveryFeatureDisabledResponse } = require("../utils/delhiveryFeatureFlags");

exports.updateWarehouse = async (req, res) => {
  const input = req.body || {};
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const pin = typeof input.pin === "string" ? input.pin.trim() : "";
  const address = typeof input.address === "string" ? input.address.trim() : "";
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  if (!name || !/^\d{6}$/.test(pin) || (address && address.length > 250) || (phone && !/^\d{10}$/.test(phone))) return res.status(400).json({ success: false, message: "Provide a valid registered warehouse name, pincode and optional address/phone." });
  let existing;
  try {
    existing = await Warehouse.findOne({ owner: req.user.id, nameKey: warehouseKey(name), state: "saved" });
  } catch {
    return res.status(503).json({ success: false, message: "Warehouse ownership could not be verified." });
  }
  if (!existing) return res.status(404).json({ success: false, message: "Warehouse not found for your login. Legacy browser-saved warehouses must be verified and registered before they can be updated." });
  const localDetails = { ...existing.details };
  for (const key of ["registered_name", "contact_name", "email", "city", "state", "country", "return_address", "return_pin", "return_city", "return_state", "return_country"]) if (typeof input[key] === "string" && input[key].trim()) localDetails[key] = input[key].trim();
  const providerChanged = pin !== String(existing.details?.pin || "") || address !== String(existing.details?.address || "") || (phone && phone !== String(existing.details?.phone || ""));
  const localChanged = Object.keys(localDetails).some(key => localDetails[key] !== existing.details?.[key]);
  if (!providerChanged && localChanged) {
    const saved = await Warehouse.updateOne({ _id: existing._id, owner: req.user.id, nameKey: warehouseKey(name), state: "saved" }, { $set: { details: localDetails } });
    if (saved.matchedCount !== 1) return res.status(409).json({ success: false, message: "Warehouse changed before the local update could be saved. Reload and retry." });
    return res.status(200).json({ success: true, message: "Local warehouse details updated. No provider request was sent.", warehouse: warehouseView({ ...existing, details: localDetails }) });
  }
  if (!isDelhiveryFeatureEnabled("WAREHOUSE_UPDATE")) return delhiveryFeatureDisabledResponse(res, "WAREHOUSE_UPDATE");
  try {
    const pending = await Warehouse.updateOne(
      { _id: existing._id, owner: req.user.id, nameKey: warehouseKey(name), state: "saved" },
      { $set: { updateStatus: "PENDING", lastOperationCode: "", lastOperationAt: new Date() } }
    );
    if (pending.matchedCount !== 1) return res.status(409).json({ success: false, message: "Warehouse changed before the update could start. Reload and retry." });
  } catch {
    return res.status(503).json({ success: false, message: "Warehouse update could not be recorded. No provider request was sent." });
  }

  let response;
  try {
    response = await delhiveryApi.post("/api/backend/clientwarehouse/edit/", { name: existing.name, pin, ...(address && { address }), ...(phone && { phone }) });
  } catch (error) {
    const outcome = failureState(error);
    try {
      const recorded = await Warehouse.updateOne(
        { _id: existing._id, owner: req.user.id, nameKey: warehouseKey(name), state: "saved" },
        { $set: { details: localDetails, updateStatus: outcome.updateStatus, lastOperationCode: outcome.code, lastOperationAt: new Date() } }
      );
      if (recorded.matchedCount !== 1) return res.status(503).json({ success: false, code: "WAREHOUSE_UPDATE_OUTCOME_UNCONFIRMED", message: "The update outcome could not be recorded. The last registered details were preserved; check before retrying." });
    } catch {
      return res.status(503).json({ success: false, code: "WAREHOUSE_UPDATE_OUTCOME_UNCONFIRMED", message: "The update outcome could not be saved locally. Check the provider and database before retrying." });
    }
    if (outcome.code === "PROVIDER_CONFIGURATION_MISSING") return res.status(503).json({ success: false, code: "DELHIVERY_CONFIGURATION_REQUIRED", message: "Delhivery integration is not fully configured. The last registered details were preserved." });
    return outcome.updateStatus === "FAILED"
      ? res.status(502).json({ success: false, code: "WAREHOUSE_UPDATE_FAILED", message: "Delhivery rejected the warehouse update. The last registered details were preserved." })
      : res.status(502).json({ success: false, code: "WAREHOUSE_UPDATE_OUTCOME_UNCONFIRMED", message: "Delhivery did not confirm the warehouse update. The last registered details were preserved; check before retrying." });
  }

  const receipt = safeProviderSnapshot(response.data);
  try {
    const updated = await Warehouse.updateOne(
      { _id: existing._id, owner: req.user.id, nameKey: warehouseKey(name), state: "saved" },
      { $set: { details: { ...localDetails, pin, ...(address && { address }), ...(phone && { phone }) }, receipt, registrationStatus: "REGISTERED", updateStatus: "SUCCEEDED", lastOperationCode: "", lastOperationAt: new Date() } }
    );
    if (updated.matchedCount !== 1) {
      try { await Warehouse.updateOne({ _id: existing._id, owner: req.user.id }, { $set: { updateStatus: "OUTCOME_UNCONFIRMED", lastOperationCode: "LOCAL_PERSISTENCE_UNCONFIRMED", lastOperationAt: new Date() } }); } catch { /* Preserve the last known record if it still exists. */ }
      return res.status(503).json({ success: false, code: "WAREHOUSE_UPDATE_OUTCOME_UNCONFIRMED", message: "The provider accepted the update, but local ownership could not be confirmed. Check before retrying." });
    }
    return res.status(200).json({ success: true, message: "Warehouse updated successfully. Unsupported fields were updated locally only.", data: receipt, warehouse: warehouseView({ ...existing, details: { ...localDetails, pin, ...(address && { address }), ...(phone && { phone }) }, receipt, registrationStatus: "REGISTERED", updateStatus: "SUCCEEDED" }) });
  } catch (error) {
    try {
      await Warehouse.updateOne({ _id: existing._id, owner: req.user.id, nameKey: warehouseKey(name), state: "saved" }, { $set: { updateStatus: "OUTCOME_UNCONFIRMED", lastOperationCode: "LOCAL_PERSISTENCE_FAILED", lastOperationAt: new Date() } });
    } catch { /* Keep the prior registered detail snapshot intact. */ }
    return res.status(503).json({ success: false, code: "WAREHOUSE_UPDATE_OUTCOME_UNCONFIRMED", message: "The provider accepted the request, but warehouse details could not be saved. The last registered details were preserved; check before retrying." });
  }
};
