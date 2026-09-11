const axios = require("axios");
const handleError = require("../utils/delhiveryError");

exports.createShipment = async (req, res) => {
  try {
    const shipmentData = req.body;

    const response = await axios.post(
      `${process.env.DELHIVERY_BASE_URL}/api/cmu/create.json`,
      `format=json&data=${encodeURIComponent(
        JSON.stringify(shipmentData)
      )}`,
      {
        headers: {
          Authorization: `Token ${process.env.DELHIVERY_API_TOKEN}`,
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
      }
    );

    return res.status(201).json({
      success: true,
      message: "Shipment created successfully",
      data: response.data,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
