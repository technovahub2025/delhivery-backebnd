const delhiveryApi = require("../services/delhiveryService");
const Warehouse = require("../model/delhiveryWarehouse");
const { safeProviderSnapshot } = require("../utils/delhiveryError");
const { isDelhiveryFeatureEnabled, delhiveryFeatureDisabledResponse } = require("../utils/delhiveryFeatureFlags");

const fields = ["name", "registered_name", "contact_name", "phone", "email", "address", "pin", "city", "state", "country", "return_address", "return_pin", "return_city", "return_state", "return_country"];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateWarehouse(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) return null;
  const data = {};
  for (const field of fields) {
    const value = body[field];
    if (field === "contact_name" && (value == null || value === "")) { data[field] = ""; continue; }
    if (typeof value !== "string" || !value.trim() || value.trim().length > (field.includes("address") ? 250 : 120)) return null;
    data[field] = value.trim();
  }
  if (!/^\d{10}$/.test(data.phone) || !emailPattern.test(data.email) || !/^\d{6}$/.test(data.pin) || !/^\d{6}$/.test(data.return_pin)) return null;
  return data;
}
function warehouseKey(name) { return name.trim().toLocaleLowerCase("en-IN"); }

function registrationStatus(row) {
  return row.registrationStatus || (row.state === "saved" ? "REGISTERED" : "CREATING");
}

function warehouseView(row) {
  const id = String(row._id);
  return { _id: id, id, name: row.name, details: row.details, registrationStatus: registrationStatus(row), updateStatus: row.updateStatus || null, lastOperationCode: row.lastOperationCode || "" };
}

function failureState(error) {
  if (error?.code === "DELHIVERY_CONFIGURATION_ERROR") return { registrationStatus: "FAILED", updateStatus: "FAILED", code: "PROVIDER_CONFIGURATION_MISSING" };
  return error?.response?.status >= 400 && error.response.status < 500
    ? { registrationStatus: "FAILED", updateStatus: "FAILED", code: "PROVIDER_REJECTED" }
    : { registrationStatus: "OUTCOME_UNCONFIRMED", updateStatus: "OUTCOME_UNCONFIRMED", code: "PROVIDER_OUTCOME_UNCONFIRMED" };
}

function providerFailureResponse(res, outcome, persistenceFailed = false, failureCode = "") {
  if (persistenceFailed) return res.status(503).json({ success: false, code: "WAREHOUSE_OUTCOME_UNCONFIRMED", message: "Warehouse provider status could not be saved. Check the provider and database before retrying." });
  if (failureCode === "PROVIDER_CONFIGURATION_MISSING") return res.status(503).json({ success: false, code: "DELHIVERY_CONFIGURATION_REQUIRED", message: "Delhivery integration is not fully configured. No provider response was received." });
  if (outcome === "FAILED") return res.status(502).json({ success: false, code: "WAREHOUSE_REGISTRATION_FAILED", message: "Delhivery rejected warehouse registration. Correct the details before retrying." });
  return res.status(502).json({ success: false, code: "WAREHOUSE_OUTCOME_UNCONFIRMED", message: "Delhivery did not confirm warehouse registration. Check its status before retrying." });
}

exports.listWarehouses = async (req, res) => {
  try {
    const rows = await Warehouse.find({ owner: req.user.id }).sort({ nameKey: 1, _id: 1 }).limit(200).lean();
    const warehouses = rows.map(warehouseView);
    return res.json({ success: true, data: { warehouses, total: warehouses.length, limit: 200 } });
  } catch {
    return res.status(503).json({ success: false, message: "Warehouses could not be loaded from the database." });
  }
};

exports.createWarehouse = async (req, res) => {
  const details = validateWarehouse(req.body);
  if (!details) return res.status(400).json({ success: false, message: "Valid warehouse details are required." });
  if (!isDelhiveryFeatureEnabled("WAREHOUSE_CREATE")) return delhiveryFeatureDisabledResponse(res, "WAREHOUSE_CREATE");
  const nameKey = warehouseKey(details.name);
  let reservation;
  try {
    reservation = await Warehouse.create({ owner: req.user.id, name: details.name, nameKey, state: "creating", registrationStatus: "CREATING", details });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: "This warehouse name is already registered. Contact your account administrator if you believe it belongs to your account." });
    return res.status(503).json({ success: false, message: "Warehouse ownership could not be recorded. No provider request was sent." });
  }

  let response;
  try {
    const providerDetails = Object.fromEntries(["name", "registered_name", "phone", "email", "address", "city", "pin", "country", "return_address", "return_city", "return_pin", "return_state", "return_country"].map(field => [field, details[field]]));
    response = await delhiveryApi.post("/api/backend/clientwarehouse/create/", providerDetails);
  } catch (error) {
    const outcome = failureState(error);
    let persisted = false;
    try {
      const result = await Warehouse.updateOne(
        { _id: reservation._id, owner: req.user.id, state: "creating" },
        { $set: { registrationStatus: outcome.registrationStatus, lastOperationCode: outcome.code, lastOperationAt: new Date() } }
      );
      persisted = result.matchedCount === 1;
    } catch { /* Report the uncertain persistence outcome without a retry. */ }
    return providerFailureResponse(res, outcome.registrationStatus, !persisted, outcome.code);
  }

  const receipt = safeProviderSnapshot(response.data);
  try {
    const saved = await Warehouse.updateOne(
      { _id: reservation._id, owner: req.user.id, state: "creating" },
      { $set: { state: "saved", registrationStatus: "REGISTERED", receipt, lastOperationCode: "", lastOperationAt: new Date() } }
    );
    if (saved.matchedCount !== 1) {
      try { await Warehouse.updateOne({ _id: reservation._id, owner: req.user.id }, { $set: { registrationStatus: "OUTCOME_UNCONFIRMED", lastOperationCode: "LOCAL_PERSISTENCE_UNCONFIRMED", lastOperationAt: new Date() } }); } catch { /* Keep the reservation as a recovery reference. */ }
      return res.status(503).json({ success: false, code: "WAREHOUSE_OUTCOME_UNCONFIRMED", message: "The provider accepted the warehouse, but its registration could not be confirmed in the database. Check before retrying." });
    }
  } catch {
    try {
      await Warehouse.updateOne({ _id: reservation._id, owner: req.user.id, state: "creating" }, { $set: { registrationStatus: "OUTCOME_UNCONFIRMED", lastOperationCode: "LOCAL_PERSISTENCE_FAILED", lastOperationAt: new Date() } });
    } catch { /* The original reservation remains the recovery reference. */ }
    return res.status(503).json({ success: false, code: "WAREHOUSE_OUTCOME_UNCONFIRMED", message: "The provider accepted the warehouse, but its registration could not be confirmed in the database. Check before retrying." });
  }

  return res.status(201).json({ success: true, message: "Warehouse created successfully", data: receipt, warehouse: warehouseView({ ...reservation, state: "saved", registrationStatus: "REGISTERED", receipt }) });
};

exports.validateWarehouse = validateWarehouse;
exports.warehouseKey = warehouseKey;
exports.safeProviderSnapshot = safeProviderSnapshot;
exports.warehouseView = warehouseView;
exports.failureState = failureState;
exports.providerFailureResponse = providerFailureResponse;
