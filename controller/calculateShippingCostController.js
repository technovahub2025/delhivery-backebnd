const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");
const { isDelhiveryFeatureEnabled, delhiveryFeatureDisabledResponse } = require("../utils/delhiveryFeatureFlags");

exports.calculateShippingCost = async (req, res) => {
  try {
    if (!isDelhiveryFeatureEnabled("SHIPPING_COST")) return delhiveryFeatureDisabledResponse(res, "SHIPPING_COST");

    const {
      md,
      ss,
      d_pin,
      o_pin,
      cgm,
      pt,
    } = req.query;

    if (typeof md !== "string" || !/^[A-Za-z]{1,20}$/.test(md) ||
        typeof ss !== "string" || !/^[A-Za-z]{1,30}$/.test(ss) ||
        typeof d_pin !== "string" || !/^\d{6}$/.test(d_pin) ||
        typeof o_pin !== "string" || !/^\d{6}$/.test(o_pin) ||
        typeof cgm !== "string" || !/^\d{1,9}(?:\.\d{1,3})?$/.test(cgm) || Number(cgm) <= 0 ||
        typeof pt !== "string" || !/^[A-Za-z-]{1,20}$/.test(pt)) {
      return res.status(400).json({ success: false, message: "Valid md, ss, d_pin, o_pin, cgm and pt values are required" });
    }

    const response = await delhiveryApi.get(
      "/api/kinko/v1/invoice/charges/.json",
      {
        params: {
          md,
          ss,
          d_pin,
          o_pin,
          cgm,
          pt,
        },
      }
    );

    const providerResponse = response?.data;
    let quote = providerResponse;
    if (quote && typeof quote === "object" && quote.data !== undefined) quote = quote.data;
    if (Array.isArray(quote)) quote = quote[0];
    const rawAmount = quote?.total_amount;
    const amount = typeof rawAmount === "number" || (typeof rawAmount === "string" && rawAmount.trim() !== "") ? Number(rawAmount) : NaN;
    if (!Number.isFinite(amount) || amount <= 0) {
      const error = new Error("Delhivery returned no valid shipping quotation.");
      error.code = "INVALID_PROVIDER_QUOTE";
      // Keep the raw body on the internal error for controlled diagnostics only.
      error.providerResponseSnapshot = providerResponse;
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: providerResponse,
    });

  } catch (error) {
    return handleError(res, error);
  }
};
