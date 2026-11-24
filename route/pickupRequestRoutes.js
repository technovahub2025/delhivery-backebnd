const createPickupRequestRouter = require("../services/pickupRequestRouter");
const PickupRequest = require("../model/pickupRequest");
const Shipment = require("../model/appShipment");
const Warehouse = require("../model/delhiveryWarehouse");
const carrier = require("../services/delhiveryService");
const { createPartnerRegistry } = require("../services/courierQuotationService");
const { createDelhiveryCourierAdapter } = require("../services/delhiveryCourierAdapter");
const { loadStatusMappings } = require("../services/providerStatusMappings");
const { isDelhiveryFeatureEnabled } = require("../utils/delhiveryFeatureFlags");

const adapters = isDelhiveryFeatureEnabled("PICKUP_CREATION") || isDelhiveryFeatureEnabled("PICKUP_STATUS")
  ? [createDelhiveryCourierAdapter(carrier)] : [];
const router = createPickupRequestRouter({ PickupRequest, Shipment, Warehouse, partnerRegistry: createPartnerRegistry(adapters), statusMappings: loadStatusMappings() });
router.createPickupRequestRouter = createPickupRequestRouter;
module.exports = router;
