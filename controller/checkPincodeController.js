const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");
const { getPincodeServiceability, isPostalCodeServiceable } = require("../services/delhiveryCourierAdapter");
const { isDelhiveryFeatureEnabled, delhiveryFeatureDisabledResponse } = require("../utils/delhiveryFeatureFlags");
const { withSafeReadRetry } = require("../utils/safeReadRetry");

exports.checkPincode = async (req, res) => {
  try {
    const { pincode, source } = req.query;

    if (typeof pincode !== "string" || !/^\d{6}$/.test(pincode)) {
      return res.status(400).json({
        success: false,
        message: "A valid 6-digit pincode is required",
      });
    }
    if (source !== undefined && source !== "sample") {
      return res.status(400).json({ success: false, message: "Invalid serviceability source." });
    }
    const carrierEnabled = isDelhiveryFeatureEnabled("PINCODE_SERVICEABILITY");
    if (source === "sample") return res.status(410).json({ success: false, code: "SAMPLE_SERVICEABILITY_REMOVED", message: "Sample serviceability is no longer available. Use the Delhivery serviceability integration." });
    if (!carrierEnabled) {
      if (process.env.DELHIVERY_PINCODE_SERVICEABILITY_ENABLED !== undefined) {
        return delhiveryFeatureDisabledResponse(res, "PINCODE_SERVICEABILITY");
      }
      return res.status(503).json({ success: false, code: "DELHIVERY_CONFIGURATION_ERROR", message: "Delhivery credentials or the HTTPS API base URL are missing or invalid. No carrier request was made." });
    }

    const result = await withSafeReadRetry(() => getPincodeServiceability(delhiveryApi, pincode), { policy: "providerQuote" });
    const serviceability = {
      prepaid: result.delivery_codes.some(({ postal_code }) => isPostalCodeServiceable(postal_code, "pre_paid")),
      cod: result.delivery_codes.some(({ postal_code }) => isPostalCodeServiceable(postal_code, "cod")),
    };

    return res.status(200).json({
      success: true,
      pincode,
      serviceable: serviceability.prepaid || serviceability.cod,
      serviceability,
      provenance: "DELHIVERY_API",
      data: handleError.safeProviderSnapshot(result),
    });

  } catch (error) {
    const status = error?.response?.status;
    const timeout = ["ETIMEDOUT", "ECONNABORTED"].includes(error?.code);
    const configuration = error?.code === "DELHIVERY_CONFIGURATION_ERROR";
    const invalidResponse = error?.code === "DELHIVERY_PINCODE_INVALID_RESPONSE";
    const code = configuration ? "DELHIVERY_CONFIGURATION_ERROR" : timeout ? "DELHIVERY_PINCODE_TIMEOUT" :
      invalidResponse ? "DELHIVERY_PINCODE_INVALID_RESPONSE" : "DELHIVERY_PINCODE_REQUEST_FAILED";
    const message = configuration ? "Delhivery credentials or the HTTPS API base URL are missing or invalid." :
      timeout ? "The Delhivery pincode lookup timed out. Retry the lookup." :
      invalidResponse ? "Delhivery returned an unrecognized pincode response." :
      Number.isInteger(status) ? `Delhivery pincode lookup failed (carrier HTTP ${status}).` :
      "The backend could not reach Delhivery for the pincode lookup.";
    res.locals.safeErrorCode = code;
    return res.status(configuration ? 503 : timeout ? 504 : 502).json({
      success: false, code, message, correlationId: req.correlationId,
    });
  }
};
