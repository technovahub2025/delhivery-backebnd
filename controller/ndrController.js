const delhiveryApi = require("../services/delhiveryService");
const handleError = require("../utils/delhiveryError");
const Shipment = require("../model/appShipment");

const ALLOWED_ACTIONS = ["RE-ATTEMPT", "PICKUP_RESCHEDULE"];

function getTrackingInstructions(entry) {
  const liveShipment = entry?.Shipment;
  if (!liveShipment) return [];

  const statusInstruction = liveShipment.Status?.Instructions || "";
  const statusType = liveShipment.Status?.StatusType || "";
  const statusStatus = liveShipment.Status?.Status || "";

  const scanInstructions = (liveShipment.Scans || [])
    .map((scan) => scan?.ScanDetail?.Instructions || "")
    .filter(Boolean);

  return [
    statusInstruction,
    statusType,
    statusStatus,
    ...scanInstructions,
  ].filter(Boolean);
}

exports.listNdrCases = async (req, res) => {
  try {
    const shipments = await Shipment.find({
      owner: req.user.id,
      state: "saved",
      waybill: { $exists: true, $nin: ["", null] },
      $or: [
        { kind: "forward" },
        { kind: { $exists: false } },
      ],
    })
      .select("waybill reference record createdAt")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const cases = [];
    let trackingFailed = 0;

    for (const shipment of shipments) {
      try {
        const response = await delhiveryApi.get(
          "/api/v1/packages/json/",
          { params: { waybill: String(shipment.waybill) } }
        );

        const data = response.data?.ShipmentData;
        if (!Array.isArray(data) || data.length === 0) {
          trackingFailed += 1;
          continue;
        }

        for (const entry of data) {
          const live = entry?.Shipment;
          if (!live) continue;

          const instructions = getTrackingInstructions(entry);
          const status = live.Status?.Status || "";
          const statusType = live.Status?.StatusType || "";

          const isNdr = instructions.some((value) =>
            /non.?delivery|ndr|delivery attempted|consignee unavailable|customer not available|refused|incomplete address|bad address/i.test(value)
          ) || /^(undelivered|exception|delivery attempted)$/i.test(status) ||
            /^undelivered$/i.test(statusType);

          if (!isNdr) continue;

          cases.push({
            waybill: String(shipment.waybill),
            reference: shipment.reference || shipment.record?.reference || "",
            customer: shipment.record?.customer || "",
            destination: shipment.record?.destination || "",
            payment: shipment.record?.payment || "",
            status,
            reason: instructions.join(" | "),
            lastUpdated: live.Status?.StatusDateTime || "",
            createdAt: shipment.createdAt || null,
          });
        }
      } catch (error) {
        trackingFailed += 1;
        console.warn(
          `NDR tracking failed for waybill ${shipment.waybill}:`,
          error.message
        );
      }
    }

    return res.json({
      success: true,
      data: {
        cases,
        checked: shipments.length,
        trackingFailed,
        complete: trackingFailed === 0,
      },
    });
  } catch (error) {
    console.error("NDR case list failed:", error.message);
    return res.status(503).json({
      success: false,
      message: "NDR cases could not be loaded.",
    });
  }
};

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
      { params: { verbose: "true" } }
    );

    return res.status(200).json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    return handleError(res, error);
  }
};
