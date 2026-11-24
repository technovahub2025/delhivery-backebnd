const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");
const { isDelhiveryFeatureEnabled, delhiveryFeatureDisabledResponse } = require("../utils/delhiveryFeatureFlags");

exports.getExpectedTat = async (req, res) => {
  try {
    if (!isDelhiveryFeatureEnabled("EXPECTED_TAT")) return delhiveryFeatureDisabledResponse(res, "EXPECTED_TAT");
    const { origin_pin, destination_pin, mot = "S" } = req.query;

    if (typeof origin_pin !== "string" || !/^\d{6}$/.test(origin_pin) ||
        typeof destination_pin !== "string" || !/^\d{6}$/.test(destination_pin) ||
        typeof mot !== "string" || !/^[A-Za-z]$/.test(mot)) {
      return res.status(400).json({
        success: false,
        message: "Valid origin_pin, destination_pin and mot values are required",
      });
    }

    const response = await delhiveryApi.get(
      "/api/dc/expected_tat",
      {
        params: {
          origin_pin,
          destination_pin,
          mot,
        },
      }
    );

    return res.status(200).json({
      success: true,
      data: response.data,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
