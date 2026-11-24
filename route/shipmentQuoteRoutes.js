const Shipment = require("../model/appShipment");
const Warehouse = require("../model/delhiveryWarehouse");
const Customer = require("../model/customer");
const mongoose = require("mongoose");
const carrier = require("../services/delhiveryService");
const { createShipmentPartnerRegistry } = require("../services/shipmentPartnerRegistry");
const { createDelhiveryCourierAdapter } = require("../services/delhiveryCourierAdapter");
const { isDelhiveryFeatureEnabled } = require("../utils/delhiveryFeatureFlags");
const { loadStatusMappings } = require("../services/providerStatusMappings");

const partnerRegistry = createShipmentPartnerRegistry({ carrier, mongooseInstance: mongoose, allowMock: false });
const reconciliationAdapter = createDelhiveryCourierAdapter(carrier);
const router = require("../services/shipmentQuoteRouter")({
  Shipment, Customer, Warehouse, partnerRegistry,
  statusMappings: loadStatusMappings(),
  getReconciliationAdapter: code => code === "DELHIVERY"
    ? (isDelhiveryFeatureEnabled("TRACKING") ? reconciliationAdapter : null)
    : partnerRegistry.get(code),
});
// The development diagnostic reads this same registry instance used by quote
// and booking requests, so its adapter list reflects the live runtime registry.
router.partnerRegistry = partnerRegistry;
module.exports = router;
