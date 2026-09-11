const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.getExpectedTat = async (req, res) => {
  try {
    const { origin_pin, destination_pin, mot = "S" } = req.query;

    if (!origin_pin || !destination_pin) {
      return res.status(400).json({
        success: false,
        message: "origin_pin and destination_pin are required",
      });
    }

    const response = await delhiveryApi.get(
      "/api/dc/expected_tat",
      {
        params: {
          origin_pin,
          destination_pin,
          mot,
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
