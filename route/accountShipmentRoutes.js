const { loadStatusMappings } = require('../services/providerStatusMappings');

module.exports = require('../services/appShipmentRouter')({
  Shipment: require('../model/appShipment'),
  Warehouse: require('../model/delhiveryWarehouse'),
  Customer: require('../model/customer'),
  RateCard: require('../model/customerRateCard'),
  carrier: require('../services/delhiveryService'),
  statusMappings: loadStatusMappings(),
});
