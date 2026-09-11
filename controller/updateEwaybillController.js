const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.updateEwaybill = async (req, res) => {
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
