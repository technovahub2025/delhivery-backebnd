const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.fetchWaybill = async (req, res) => {
  try {
    const { count = 1 } = req.query;

    if (Number(count) > 10000) {
      return res.status(400).json({
        success: false,
        message: "Maximum waybill count is 10000",
      });
    }

    const response = await delhiveryApi.get(
      "/waybill/api/bulk/json/",
      {
        params: {
          count,
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
