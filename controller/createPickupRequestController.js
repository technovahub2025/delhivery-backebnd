const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.createPickupRequest = async (req, res) => {
  try {
    const response = await delhiveryApi.post(
      "/fm/request/new/",
      req.body
    );

    return res.status(201).json({
      success: true,
      message: "Pickup request created successfully",
      data: response.data,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
