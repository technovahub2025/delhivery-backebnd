const requireSession = require("../utils/requireSession");

module.exports = function createDashboardController({ Shipment, carrier }) {
  return {
    getActionRequired: [
      requireSession,
      async (req, res) => {
        try {
          const shipments = await Shipment.find({
            owner: req.user.id,
            state: "saved",
            $or: [
              { kind: "forward" },
              { kind: { $exists: false } },
            ],
          })
            .select("waybill")
            .lean();

          let badAddresses = 0;
          let trackingChecked = 0;
          let trackingFailed = 0;

          for (const shipment of shipments) {
            if (!shipment.waybill) {
              trackingFailed += 1;
              continue;
            }

            try {
              const response = await carrier.get(
                "/api/v1/packages/json/",
                {
                  params: {
                    waybill: String(shipment.waybill),
                  },
                }
              );

              const shipmentData = response.data?.ShipmentData;

              if (!Array.isArray(shipmentData) || shipmentData.length === 0) {
                trackingFailed += 1;
                continue;
              }

              trackingChecked += 1;

              const hasBadAddress = shipmentData.some((entry) => {
                const liveShipment = entry?.Shipment;
                if (!liveShipment) return false;

                const statusInstruction =
                  liveShipment.Status?.Instructions || "";

                const hasBadAddressStatus =
                  /bad\/incomplete address/i.test(statusInstruction);

                const hasBadAddressScan = (
                  liveShipment.Scans || []
                ).some((scan) =>
                  /bad\/incomplete address/i.test(
                    scan?.ScanDetail?.Instructions || ""
                  )
                );

                return hasBadAddressStatus || hasBadAddressScan;
              });

              if (hasBadAddress) badAddresses += 1;
            } catch (error) {
              trackingFailed += 1;
              console.warn(
                `Unable to fetch live tracking for waybill ${shipment.waybill}:`,
                error.message
              );
            }
          }

          const badAddressesAvailable = trackingFailed === 0;

          return res.json({
            success: true,
            data: {
              badAddresses: badAddressesAvailable ? badAddresses : null,
              badAddressesAvailable,
              trackingChecked,
              trackingFailed,
              message: badAddressesAvailable
                ? "Bad-address tracking check completed."
                : "Bad-address count is incomplete because some tracking requests failed.",
              highRiskOrders: null,
              pending: null,
              toBeShipped: null,
              exceptionsNdr: null,
            },
          });
        } catch (error) {
          console.error(
            "Action Required summary failed:",
            error.message
          );

          return res.status(503).json({
            success: false,
            message:
              "Action Required information could not be loaded. Please try again.",
          });
        }
      },
    ],
  };
};

