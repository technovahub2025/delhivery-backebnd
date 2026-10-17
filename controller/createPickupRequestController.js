const delhiveryApi = require("../services/delhiveryService");
const PickupRequest = require("../model/pickupRequest");
const handleError = require("../utils/delhiveryError");

function getCarrierId(value) {
  if (!value || typeof value !== "object") return "";
  const direct = value.pickup_id || value.request_id ||
    value.pickup_request_id || value.id;
  if (direct != null) return String(direct);
  return getCarrierId(value.data);
}

exports.createPickupRequest = async (req, res) => {
  const body = req.body || {};
  const date = String(body.pickup_date || "");
  const time = String(body.pickup_time || "");
  const location = body.pickup_location;
  const warehouse = typeof location === "string"
    ? location
    : String(location?.name || "");
  const count = Number(body.expected_package_count);

  if (!date || !time || !warehouse.trim() ||
      !Number.isInteger(count) || count < 1) {
    return res.status(400).json({
      success: false,
      message: "Provide a pickup date, time, registered warehouse and positive package count."
    });
  }

  let carrierResponse;
  try {
    const response = await delhiveryApi.post("/fm/request/new/", body);
    carrierResponse = response.data;
  } catch (error) {
    return handleError(res, error);
  }

  try {
    const record = await PickupRequest.create({
      owner: req.user.id,
      carrierRequestId: getCarrierId(carrierResponse),
      pickupDate: date,
      pickupTime: time,
      warehouse: warehouse.trim(),
      packageCount: count,
      status: "Scheduled",
      request: body,
      carrierResponse
    });

    return res.status(201).json({
      success: true,
      message: "Pickup request created and saved.",
      data: {
        pickup: {
          id: record.carrierRequestId || String(record._id),
          warehouse: record.warehouse,
          date: record.pickupDate,
          time: record.pickupTime,
          count: record.packageCount,
          status: record.status
        },
        carrierResponse
      }
    });
  } catch (error) {
    // Carrier creation already succeeded. Never retry the carrier request here.
    console.error("Pickup persistence failed after carrier response:", error.message);
    return res.status(503).json({
      success: false,
      carrierCreated: true,
      carrierRequestId: getCarrierId(carrierResponse) || null,
      message: "Delhivery responded, but the pickup could not be saved locally. Check the carrier and database before retrying."
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
    console.error("Pickup list failed:", error.message);
    return res.status(503).json({
      success: false,
      message: "Pickup requests could not be loaded from the database."
    });
  }
};
