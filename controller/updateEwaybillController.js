const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");
const { isDelhiveryFeatureEnabled, delhiveryFeatureDisabledResponse } = require("../utils/delhiveryFeatureFlags");

exports.updateEwaybill = async (req, res) => {
  if (!isDelhiveryFeatureEnabled("EWAYBILL")) return delhiveryFeatureDisabledResponse(res, "EWAYBILL");
  try {
    const response = await delhiveryApi.post(
      "/api/p/edit",
      req.body
    );

    return res.status(200).json({
      success: true,
      message: "Ewaybill updated successfully",
      data: response.data,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
