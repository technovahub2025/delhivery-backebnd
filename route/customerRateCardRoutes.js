const express = require("express");
const requireSession = require("../utils/requireSession");
const createController = require("../controller/customerRateCardController");

function createCustomerRateCardRoutes(models = {}) {
  const router = express.Router();
  const controller = createController(models);
  router.use(requireSession);
  router.post("/pricing-preview", controller.pricingPreview);
  router.get("/", controller.list);
  router.post("/", controller.create);
  router.post("/:id/versions", controller.createVersion);
  router.get("/:id", controller.get);
  router.patch("/:id", controller.update);
  return router;
}

const router = createCustomerRateCardRoutes();
router.createCustomerRateCardRoutes = createCustomerRateCardRoutes;
module.exports = router;
