const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.checkPincode = async (req, res) => {
  try {
    const { pincode } = req.query;

    if (!pincode) {
      return res.status(400).json({
        success: false,
        message: "Pincode is required",
      });
    }

    const response = await delhiveryApi.get(
      "/c/api/pin-codes/json/",
      {
        params: {
          filter_codes: pincode,
        },
      }
    );

    const deliveryCodes = response.data?.delivery_codes || [];

    const serviceable = deliveryCodes.length > 0;

    return res.status(200).json({
      success: true,
      pincode,
      serviceable,
      data: response.data,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
