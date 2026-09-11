const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.calculateShippingCost = async (req, res) => {
  try {
    const {
      md,
      ss,
      d_pin,
      o_pin,
      cgm,
      pt,
    } = req.query;

    const response = await delhiveryApi.get(
      "/api/kinko/v1/invoice/charges/.json",
      {
        params: {
          md,
          ss,
          d_pin,
          o_pin,
          cgm,
          pt,
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
