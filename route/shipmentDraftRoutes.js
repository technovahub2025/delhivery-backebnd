const Shipment = require("../model/appShipment");
const Customer = require("../model/customer");
const PartyAddress = require("../model/savedPartyAddress");
const RateCard = require("../model/customerRateCard");
const Warehouse = require("../model/delhiveryWarehouse");
module.exports = require("../services/shipmentDraftRouter")({ Shipment, Customer, PartyAddress, RateCard, Warehouse });
