const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

exports.downloadDocument = async (req, res) => {
  try {
    const { waybill, doc_type = "EPOD" } = req.query;

    if (typeof waybill !== "string" || !/^\d+$/.test(waybill.trim())) {
      return res.status(400).json({
        success: false,
        message: "A numeric waybill is required",
      });
    }

    const documentTypes = ["SIGNATURE_URL", "RVP_QC_IMAGE", "EPOD", "SELLER_RETURN_IMAGE"];
    if (!documentTypes.includes(doc_type)) {
      return res.status(400).json({
        success: false,
        message: `doc_type must be one of: ${documentTypes.join(", ")}`,
      });
    }

    const response = await delhiveryApi.get(
      "/api/rest/fetch/pkg/document/",
      {
        params: {
          waybill: waybill.trim(),
          doc_type,
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
