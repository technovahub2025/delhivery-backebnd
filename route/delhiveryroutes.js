const router = require("express").Router();

const { checkPincode } = require("../controller/checkPincodeController");
const { checkHeavyPincode } = require("../controller/checkHeavyPincodeController");
const { getExpectedTat } = require("../controller/getExpectedTatController");
const { fetchWaybill, getWaybillAllocation } = require("../controller/fetchWaybillController");
const { calculateShippingCost } = require("../controller/calculateShippingCostController");
const { generateShippingLabel } = require("../controller/generateShippingLabelController");
const { createPickupRequest, listPickupRequests } = require("../controller/createPickupRequestController");
const { createWarehouse, listWarehouses } = require("../controller/createWarehouseController");
const { updateWarehouse } = require("../controller/updateWarehouseController");
const { downloadDocument } = require("../controller/downloadDocumentController");
const { createTrackingWebhookController, configuredHeaderAuthenticator, createWebhookEventsController } = require("../controller/trackingWebhookController");
const createDashboardController = require("../controller/dashboardController");
const reverseOrderController = require("../controller/reverseOrderController");
const requireSession = require("../utils/requireSession");
const { requireOwnedShipment } = require("../utils/legacyDelhiveryAccess");

const Shipment = require("../model/appShipment");
const PickupRequest = require("../model/pickupRequest");
const NdrCase = require("../model/ndrCase");
const RtoRecord = require("../model/rtoRecord");
const carrier = require("../services/delhiveryService");
const DelhiveryWebhook = require("../model/delhiveryWebhook");
const { createPartnerRegistry } = require("../services/courierQuotationService");
const { createDelhiveryCourierAdapter } = require("../services/delhiveryCourierAdapter");
const { loadStatusMappings } = require("../services/providerStatusMappings");
const createPartnerCostRoutes = require("./partnerCostRoutes");
const { isDelhiveryFeatureEnabled } = require("../utils/delhiveryFeatureFlags");
const statusMappings = loadStatusMappings();
const trackingAdapter = createDelhiveryCourierAdapter(carrier);
const delhiveryWebhook = createTrackingWebhookController({
  DelhiveryWebhook, Shipment,
  partnerRegistry: createPartnerRegistry([trackingAdapter]),
  enabled: () => isDelhiveryFeatureEnabled("TRACKING_WEBHOOK"),
  authenticateWebhook: configuredHeaderAuthenticator(process.env.DELHIVERY_WEBHOOK_AUTHORIZATION),
});

const dashboardController = createDashboardController({
  Shipment,
  PickupRequest,
  NdrCase,
  RtoRecord,
  statusMappings,
});

router.get("/pincode", requireSession, checkPincode);
router.get("/pincode/heavy", requireSession, checkHeavyPincode);
router.get("/expected-tat", requireSession, getExpectedTat);
router.get("/waybills", requireSession, (_req, res) => res.set("Allow", "POST").status(405).json({ success: false, message: "Use POST to allocate waybills." }));
router.post("/waybills", requireSession, fetchWaybill);
router.get("/waybills/allocations/:requestId", requireSession, getWaybillAllocation);
router.post("/webhook", delhiveryWebhook);
router.get("/webhook/events", requireSession, createWebhookEventsController({ DelhiveryWebhook, adapter: trackingAdapter }));
router.use(require("./shipmentTrackingRoutes"));
router.get("/shipping-cost", requireSession, calculateShippingCost);
router.get("/shipping-label", requireSession, require("../controller/generateShippingLabelController").sampleShippingLabel, requireOwnedShipment(), generateShippingLabel);
router.use("/pickup-requests", require("./pickupRequestRoutes"));
router.post("/pickups", require("../utils/requireSession"), createPickupRequest);
router.get("/warehouses", requireSession, listWarehouses);
router.post("/warehouses", requireSession, createWarehouse);
router.post("/warehouses/update", requireSession, updateWarehouse);
router.get("/documents", requireSession, requireOwnedShipment(), downloadDocument);

router.get(
  "/dashboard/overview",
  ...dashboardController.getOverview
);
router.get(
  "/dashboard/action-required",
  ...dashboardController.getActionRequired
);

router.get("/reverse-orders", require("../utils/requireSession"), reverseOrderController.listReverseOrders);
router.post("/reverse-orders", require("../utils/requireSession"), reverseOrderController.createReverseOrder);
router.use(require("./shipmentDraftRoutes"));
router.use(require("./shipmentQuoteRoutes"));
router.use(require("./accountShipmentRoutes"));

router.use(require("./ndrRoutes"));
router.use(require("./rtoRoutes"));
router.use("/partner-costs", createPartnerCostRoutes({ Shipment }));

module.exports = router;

