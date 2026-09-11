const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.generateShippingLabel = async (req, res) => {
  try {
    const { waybill, pdf = true } = req.query;

    const response = await delhiveryApi.get(
      "/api/p/packing_slip",
      {
        params: {
          wbns: waybill,
          pdf,
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
