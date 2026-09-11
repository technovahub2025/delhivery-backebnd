const router = require("express").Router();

const { checkPincode } = require("../controller/checkPincodeController");
const { checkHeavyPincode } = require("../controller/checkHeavyPincodeController");
const { getExpectedTat } = require("../controller/getExpectedTatController");
const { fetchWaybill } = require("../controller/fetchWaybillController");
const { createShipment } = require("../controller/createShipmentController");
const { updateShipment } = require("../controller/updateShipmentController");
const { cancelShipment } = require("../controller/cancelShipmentController");
const { updateEwaybill } = require("../controller/updateEwaybillController");
const { trackShipment } = require("../controller/trackShipmentController");
const { calculateShippingCost } = require("../controller/calculateShippingCostController");
const { generateShippingLabel } = require("../controller/generateShippingLabelController");
const { createPickupRequest } = require("../controller/createPickupRequestController");
const { createWarehouse } = require("../controller/createWarehouseController");
const { updateWarehouse } = require("../controller/updateWarehouseController");
const { downloadDocument } = require("../controller/downloadDocumentController");
const { delhiveryWebhook } = require("../controller/delhiveryWebhookController");

router.get("/pincode", checkPincode);
router.get("/pincode/heavy", checkHeavyPincode);
router.get("/expected-tat", getExpectedTat);
router.get("/waybills", fetchWaybill);
router.post("/shipments", createShipment);
router.post("/shipments/update", updateShipment);
router.post("/shipments/cancel", cancelShipment);
router.post("/shipments/ewaybill", updateEwaybill);
router.get("/shipments/track", trackShipment);
router.get("/shipping-cost", calculateShippingCost);
router.get("/shipping-label", generateShippingLabel);
router.post("/pickups", createPickupRequest);
router.post("/warehouses", createWarehouse);
router.post("/warehouses/update", updateWarehouse);
router.get("/documents", downloadDocument);
router.post("/webhook", delhiveryWebhook);

module.exports = router;
