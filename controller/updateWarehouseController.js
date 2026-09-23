const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.updateWarehouse = async (req, res) => {
  try {
    const response = await delhiveryApi.post(
      "/api/backend/clientwarehouse/edit/",
      req.body
    );

    return res.status(200).json({
      success: true,
      message: "Warehouse updated successfully",
      data: response.data,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
