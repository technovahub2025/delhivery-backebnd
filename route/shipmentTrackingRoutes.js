const Shipment = require("../model/appShipment");
const carrier = require("../services/delhiveryService");
const { createShipmentPartnerRegistry } = require("../services/shipmentPartnerRegistry");
const partnerRegistry = createShipmentPartnerRegistry({ carrier, mongooseInstance: require("mongoose") }).tracking;
module.exports = require("../services/shipmentTrackingRouter").createShipmentTrackingRouter({ Shipment, partnerRegistry });
module.exports.startPolling = () => require("../services/trackingPolling").createTrackingPoller({
  Shipment, partnerRegistry, statusMappings: require("../services/providerStatusMappings").loadStatusMappings(),
}).start();
