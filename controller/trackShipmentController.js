const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.trackShipment = async (req, res) => {
  try {
    const { waybill, ref_ids = "" } = req.query;

    if (!waybill && !ref_ids) {
      return res.status(400).json({
        success: false,
        message: "Waybill or ref_ids is required",
      });
    }

    const response = await delhiveryApi.get(
      "/api/v1/packages/json/",
      {
        params: {
          waybill,
          ref_ids,
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
