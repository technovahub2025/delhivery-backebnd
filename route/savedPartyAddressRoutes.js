const express = require("express");
const requireSession = require("../utils/requireSession");
const SavedPartyAddress = require("../model/savedPartyAddress");
const Customer = require("../model/customer");
const createController = require("../controller/savedPartyAddressController");

function createSavedPartyAddressRoutes({ SavedPartyAddressModel = SavedPartyAddress, CustomerModel = Customer } = {}) {
  const router = express.Router();
  const controller = createController({ SavedPartyAddressModel, CustomerModel });
  router.use(requireSession);
  router.get("/", controller.list);
  router.post("/", controller.create);
  router.get("/:id", controller.get);
  router.patch("/:id", controller.update);
  return router;
}

const router = createSavedPartyAddressRoutes();
router.createSavedPartyAddressRoutes = createSavedPartyAddressRoutes;
module.exports = router;
