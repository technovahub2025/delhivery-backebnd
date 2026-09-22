const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.updateShipment = async (req, res) => {
  try {
    const shipmentData = req.body;

    const response = await delhiveryApi.post(
      "/api/p/edit",
      shipmentData,
      { headers: { "Content-Type": "application/json" } }
    );

    return res.status(200).json({
      success: true,
      message: "Shipment updated successfully",
      data: response.data,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
