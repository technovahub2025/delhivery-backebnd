module.exports = require('../services/appShipmentRouter')({
  Shipment: require('../model/appShipment'),
  carrier: require('../services/delhiveryService'),
});
