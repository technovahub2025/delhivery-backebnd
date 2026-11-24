const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");
const { isDelhiveryFeatureEnabled, delhiveryFeatureDisabledResponse } = require("../utils/delhiveryFeatureFlags");

exports.cancelShipment = async (req, res) => {
  if (!isDelhiveryFeatureEnabled("SHIPMENT_CANCELLATION")) return delhiveryFeatureDisabledResponse(res, "SHIPMENT_CANCELLATION");
  try {
    const { waybill } = req.body;

    if (!waybill) {
      return res.status(400).json({
        success: false,
        message: "Waybill is required",
      });
    }

    const response = await delhiveryApi.post(
      "/api/p/edit",
      {
        waybill,
        status: "Cancelled",
      }
    );

    return res.status(200).json({
      success: true,
      message: "Shipment cancellation request successful",
      data: response.data,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
