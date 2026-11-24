const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");
const { isDelhiveryFeatureEnabled, delhiveryFeatureDisabledResponse } = require("../utils/delhiveryFeatureFlags");

exports.createShipment = async (req, res) => {
  if (!isDelhiveryFeatureEnabled("SHIPMENT_BOOKING")) return delhiveryFeatureDisabledResponse(res, "SHIPMENT_BOOKING");
  try {
    const shipmentData = req.body;

    const response = await delhiveryApi.post(
      "/api/cmu/create.json",
      `format=json&data=${encodeURIComponent(
        JSON.stringify(shipmentData)
      )}`,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    return res.status(201).json({
      success: true,
      message: "Shipment created successfully",
      data: response.data,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
