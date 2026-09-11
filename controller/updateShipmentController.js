const axios = require("axios");
const handleError = require("../utils/delhiveryError");

exports.updateShipment = async (req, res) => {
  try {
    const shipmentData = req.body;

    const response = await axios.post(
      `${process.env.DELHIVERY_BASE_URL}/api/p/edit`,
      shipmentData,
      {
        headers: {
          Authorization: `Token ${process.env.DELHIVERY_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
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
