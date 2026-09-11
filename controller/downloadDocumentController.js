const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.downloadDocument = async (req, res) => {
  try {
    const { waybill } = req.query;

    const response = await delhiveryApi.get(
      "/api/p/document",
      {
        params: {
          waybill,
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
