const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");
const { isDelhiveryFeatureEnabled, delhiveryFeatureDisabledResponse } = require("../utils/delhiveryFeatureFlags");
const SAMPLE_AWB_PATTERN = /^SAMPLE-AWB-[a-f0-9]{32}$/;

exports.sampleShippingLabel = async (req, res, next) => {
  const waybill = req.query.waybill;
  if (typeof waybill !== "string" || !SAMPLE_AWB_PATTERN.test(waybill)) return next();
  return res.status(410).json({ success: false, code: "SAMPLE_LABEL_REMOVED", message: "Sample labels are no longer available. A carrier-issued AWB is required." });
};

exports.generateShippingLabel = async (req, res) => {
  try {
    if (!isDelhiveryFeatureEnabled("LABELS")) return delhiveryFeatureDisabledResponse(res, "LABELS");
    const { waybill, pdf = true } = req.query;

    if (typeof waybill !== "string" || !/^\d{6,20}$/.test(waybill) ||
        typeof pdf !== "string" && typeof pdf !== "boolean" ||
        ![true, false, "true", "false", "1", "0"].includes(pdf)) {
      return res.status(400).json({ success: false, message: "Provide one numeric waybill and a valid pdf option." });
    }

    const response = await delhiveryApi.get(
      "/api/p/packing_slip",
      {
        params: {
          wbns: waybill,
          pdf: pdf === true || pdf === "true" || pdf === "1" ? "True" : "False",
        },
      }
    );

    if (response.data?.packages_found === 0 || (Array.isArray(response.data?.packages) && response.data.packages.length === 0)) {
      return res.status(404).json({ success: false, code: "LABEL_NOT_FOUND", message: "The carrier has no label for this waybill yet." });
    }
    return res.status(200).json({
      success: true,
      data: response.data,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
