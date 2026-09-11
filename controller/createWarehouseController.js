const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.createWarehouse = async (req, res) => {
  try {
    const response = await delhiveryApi.post(
      "/api/backend/clientwarehouse/create/",
      req.body
    );

    return res.status(201).json({
      success: true,
      message: "Warehouse created successfully",
      data: response.data,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
