const mongoose = require("mongoose");

function registeredWarehouseFilter() {
  // Older confirmed warehouse records can predate registrationStatus. The
  // warehouse list has always treated saved records with no explicit status
  // as registered, so all warehouse consumers must use the same rule.
  return {
    $or: [
      { registrationStatus: "REGISTERED" },
      { state: "saved", registrationStatus: { $in: [null, ""] } },
    ],
  };
}

async function findRegisteredWarehouse(Warehouse, ownerId, warehouseId) {
  if (!Warehouse || typeof warehouseId !== "string" || !mongoose.isValidObjectId(warehouseId)) return null;
  return Warehouse.findOne({ _id: warehouseId, owner: ownerId, ...registeredWarehouseFilter() }).lean();
}

function snapshotFromWarehouse(warehouse) {
  if (!warehouse) return null;
  const details = warehouse.details && typeof warehouse.details === "object" ? warehouse.details : {};
  return {
    id: String(warehouse._id),
    name: String(warehouse.name || ""),
    address: String(details.address || ""),
    pincode: String(details.pin || details.pincode || ""),
    contact: String(details.contact_name || details.contact || ""),
    phone: String(details.phone || ""),
    registrationStatus: warehouse.registrationStatus || (warehouse.state === "saved" ? "REGISTERED" : "CREATING"),
  };
}

function applyWarehouseToForm(form, snapshot) {
  return {
    ...form,
    warehouseId: snapshot.id,
    warehouse: snapshot.name,
    warehouseAddress: snapshot.address,
    warehousePincode: snapshot.pincode,
    warehouseContact: snapshot.contact,
    warehousePhone: snapshot.phone,
  };
}

function sameRegisteredWarehouseSnapshot(saved, current) {
  return Boolean(saved && current && ["id", "name", "address", "pincode", "contact", "phone", "registrationStatus"]
    .every(key => String(saved[key] ?? "") === String(current[key] ?? "")));
}

module.exports = { findRegisteredWarehouse, registeredWarehouseFilter, snapshotFromWarehouse, applyWarehouseToForm, sameRegisteredWarehouseSnapshot };
