const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");

const ALLOWED_ACTIONS = ["RE-ATTEMPT", "PICKUP_RESCHEDULE"];

exports.updateNdr = async (req, res) => {
  try {
    const waybill = String(req.body?.waybill || "").trim();
    const act = String(req.body?.act || "").trim().toUpperCase();

    if (!waybill || waybill.length > 80) {
      return res.status(400).json({
        success: false,
        message: "A valid waybill is required.",
      });
    }

    if (!ALLOWED_ACTIONS.includes(act)) {
      return res.status(400).json({
        success: false,
        message: "Action must be RE-ATTEMPT or PICKUP_RESCHEDULE.",
      });
    }

    const response = await delhiveryApi.post("/api/p/update", {
      data: [{ waybill, act }],
    });

    return res.status(200).json({
      success: true,
      message: "NDR request submitted. Check the returned UPL ID for processing status.",
      data: response.data,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.getNdrStatus = async (req, res) => {
  try {
    const uplId = String(req.params.uplId || "").trim();

    if (!/^UPL[A-Za-z0-9_-]{1,100}$/.test(uplId)) {
      return res.status(400).json({
        success: false,
        message: "A valid UPL ID is required.",
      });
    }

    const response = await delhiveryApi.get(
      `/api/cmu/get_bulk_upl/${encodeURIComponent(uplId)}`,
      {
        params: { verbose: "true" },
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
