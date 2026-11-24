const express = require("express");
const requireSession = require("../utils/requireSession");
const Customer = require("../model/customer");
const CustomerRateCard = require("../model/customerRateCard");
const createCustomerController = require("../controller/customerController");

function createCustomerRoutes({ CustomerModel = Customer, RateCardModel = CustomerRateCard } = {}) {
  const router = express.Router();
  const controller = createCustomerController(CustomerModel, RateCardModel);

  router.use(requireSession);
  router.get("/", controller.list);
  router.post("/", controller.create);
  router.get("/:id", controller.get);
  router.patch("/:id", controller.update);

  return router;
}

const router = createCustomerRoutes();
router.createCustomerRoutes = createCustomerRoutes;

module.exports = router;
