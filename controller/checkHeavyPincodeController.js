const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.checkHeavyPincode = async (req, res) => {
  try {
    const { pincode } = req.query;

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
      data: response.data,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
