const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");
const { isDelhiveryFeatureEnabled, delhiveryFeatureDisabledResponse } = require("../utils/delhiveryFeatureFlags");

exports.checkHeavyPincode = async (req, res) => {
  try {
    if (!isDelhiveryFeatureEnabled("HEAVY_PINCODE_SERVICEABILITY")) return delhiveryFeatureDisabledResponse(res, "HEAVY_PINCODE_SERVICEABILITY");
    const { pincode } = req.query;

    if (typeof pincode !== "string" || !/^\d{6}$/.test(pincode)) {
      return res.status(400).json({ success: false, message: "A valid 6-digit pincode is required" });
    }

    const response = await delhiveryApi.get(
      "/api/dc/fetch/serviceability/pincode",
      {
        params: {
          product_type: "Heavy",
          pincode,
        },
      }
    );

    return res.status(200).json({
      success: true,
      provenance: "DELHIVERY_API",
      data: response.data,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
