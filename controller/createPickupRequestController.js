const { createHash } = require("node:crypto");
const delhiveryApi = require("../services/delhiveryService");
const PickupRequest = require("../model/pickupRequest");
const Warehouse = require("../model/delhiveryWarehouse");
const Shipment = require("../model/appShipment");
const { PickupInputError, pickupDetails, shipmentCountOf, resolvePickupShipmentRefs, serializePickup } = require("../services/pickupRequestRouter");
const handleError = require("../utils/delhiveryError");
const { safeProviderSnapshot } = handleError;
const { createDelhiveryCourierAdapter } = require("../services/delhiveryCourierAdapter");
const { registeredWarehouseFilter } = require("../services/warehouseValidation");
const { isDelhiveryFeatureEnabled, delhiveryFeatureDisabledResponse } = require("../utils/delhiveryFeatureFlags");
const { warehouseKey } = require("./createWarehouseController");

exports.createPickupRequest = async (req, res) => {
  if (!isDelhiveryFeatureEnabled("PICKUP_CREATION")) return delhiveryFeatureDisabledResponse(res, "PICKUP_CREATION");
  const body = req.body || {};
  const date = String(body.pickup_date || "").trim();
  const time = String(body.pickup_time || "").trim();
  const location = body.pickup_location;
  const warehouse = typeof location === "string" ? location : String(location?.name || "");
  const count = Number(body.expected_package_count);
  const parsedDate = new Date(date + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date ||
      !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(time) || !warehouse.trim() || warehouse.length > 120 ||
      !Number.isSafeInteger(count) || count < 1) {
    return res.status(400).json({ success: false, message: "Provide a valid pickup date, time, registered warehouse and positive package count." });
  }

  const owner = req.user.id;
  const slotTime = time.length === 5 ? time + ":00" : time;
  const duplicate = () => res.status(409).json({
    success: false, code: "PICKUP_ALREADY_REQUESTED",
    message: "An identical pickup request already exists or is awaiting confirmation. Check its status before retrying.",
  });
  let reservation;
  let request;
  try {
    const registered = await Warehouse.findOne({ owner, nameKey: warehouseKey(warehouse), ...registeredWarehouseFilter() });
    if (!registered) return res.status(404).json({ success: false, code: "WAREHOUSE_INVALID", message: "Registered pickup warehouse not found for this account." });
    const metadata = body.localDetails ?? {};
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new PickupInputError("Invalid local pickup details.");
    const details = pickupDetails(metadata, date, slotTime);
    const rawWeight = metadata.totalWeightKg;
    const weightText = rawWeight == null ? "" : String(rawWeight).trim().replace(",", ".");
    const parsedWeight = weightText ? Number(weightText) : NaN;
    const totalWeightKg = rawWeight == null ? undefined : parsedWeight;
    if (totalWeightKg !== undefined && (!Number.isFinite(totalWeightKg) || totalWeightKg <= 0)) {
      throw new PickupInputError("Total weight must be greater than zero kilograms.");
    }
    const shipmentRefs = await resolvePickupShipmentRefs(Shipment, owner, metadata.shipmentRefs === undefined ? [] : metadata.shipmentRefs, { provider: "DELHIVERY" });
    const shipmentCount = shipmentCountOf(metadata.shipmentCount, shipmentRefs);
    const warehouseDetails = registered.details || {};
    const localLocation = { name: registered.name, address: warehouseDetails.address || "", contactName: warehouseDetails.contact_name || "",
      phone: warehouseDetails.phone || "", email: warehouseDetails.email || "", city: warehouseDetails.city || "",
      state: warehouseDetails.state || "", pincode: warehouseDetails.pin || "" };
    const carrierRequestKey = createHash("sha256").update(JSON.stringify([registered.nameKey, date, slotTime, count])).digest("hex");
    await PickupRequest.init();
    const times = slotTime.endsWith(":00") ? [slotTime, slotTime.slice(0, 5)] : [slotTime];
    if (await PickupRequest.exists({
      owner, warehouse: registered.name, pickupDate: date, pickupTime: { $in: times },
      packageCount: count, workflow: { $ne: "LOCAL" },
    })) return duplicate();
    request = {
      pickup_date: date,
      pickup_time: slotTime,
      pickup_location: registered.name,
      expected_package_count: count,
    };
    reservation = await PickupRequest.create({
      owner, carrierRequestKey, providerCode: "DELHIVERY", workflow: "CARRIER",
      carrierSubmissionStatus: "SUBMITTING", pickupDate: date, pickupTime: time,
      warehouse: registered.name, packageCount: count, status: "Submission pending", request,
      ...details, totalWeightKg, shipmentRefs, shipmentCount, location: localLocation,
      carrierResponse: { status: "SUBMITTING" },
    });
  } catch (error) {
    if (error instanceof PickupInputError) return res.status(400).json({ success: false, message: error.message });
    if (error?.code === 11000) return duplicate();
    return res.status(503).json({ success: false, code: "PICKUP_RESERVATION_FAILED", message: "The pickup could not be reserved. No provider request was sent." });
  }

  const claim = { _id: reservation._id, owner, carrierSubmissionStatus: "SUBMITTING" };
  let carrierResponse;
  let carrierRequestId;
  try {
    const adapter = createDelhiveryCourierAdapter(delhiveryApi);
    const response = await adapter.createPickup({ request });
    carrierRequestId = response.carrierRequestId;
    carrierResponse = safeProviderSnapshot(response.responseSnapshot);
  } catch (error) {
    if (error?.outcome === "REJECTED" || ["DELHIVERY_FEATURE_DISABLED", "DELHIVERY_CONFIGURATION_ERROR"].includes(error?.code)) {
      try { await PickupRequest.deleteOne(claim); } catch { /* Retain the reservation when its removal cannot be confirmed. */ }
      return handleError(res, error);
    }
    try {
      await PickupRequest.updateOne(claim, { $set: { carrierSubmissionStatus: "OUTCOME_UNCONFIRMED", status: "Outcome unconfirmed" } });
    } catch { /* The existing reservation still blocks duplicate submissions. */ }
    return res.status(502).json({ success: false, code: "PICKUP_OUTCOME_UNCONFIRMED", message: "Delhivery did not confirm pickup creation. Check Delhivery before retrying." });
  }

  try {
    const saved = await PickupRequest.updateOne(claim, { $set: {
      carrierRequestId, carrierResponse, carrierSubmissionStatus: "CONFIRMED", status: "Scheduled",
    } });
    if (saved.matchedCount !== 1) throw new Error("Pickup reservation changed.");
    return res.status(201).json({
      success: true,
      message: "Pickup request created and saved.",
      data: { pickup: { ...serializePickup({ ...(reservation.toObject?.() || reservation), carrierRequestId, status: "Scheduled" }), id: carrierRequestId }, carrierResponse },
    });
  } catch {
    return res.status(503).json({
      success: false, carrierCreated: true, carrierRequestId,
      message: "Delhivery responded, but the pickup could not be saved locally. Check the carrier and database before retrying.",
    });
  }
};

exports.listPickupRequests = async (req, res) => {
  try {
    const records = await PickupRequest.find({ owner: req.user.id })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.json({
      success: true,
      data: {
        pickups: records.map((record) => ({
          id: record.carrierRequestId || String(record._id),
          warehouse: record.warehouse,
          date: record.pickupDate,
          time: record.pickupTime,
          count: record.packageCount,
          status: record.status
        })),
        total: records.length
      }
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      message: "Pickup requests could not be loaded from the database."
    });
  }
};
