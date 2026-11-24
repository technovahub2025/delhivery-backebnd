const Shipment = require("../model/appShipment");
const NdrCase = require("../model/ndrCase");
const carrier = require("../services/delhiveryService");
const { createPartnerRegistry } = require("../services/courierQuotationService");
const { createDelhiveryCourierAdapter } = require("../services/delhiveryCourierAdapter");
const { loadStatusMappings } = require("../services/providerStatusMappings");
const { isDelhiveryFeatureEnabled } = require("../utils/delhiveryFeatureFlags");
const adapter = createDelhiveryCourierAdapter(carrier);
const partnerRegistry = createPartnerRegistry(() => {
  const actions = isDelhiveryFeatureEnabled("NDR_OPERATIONS");
  const status = isDelhiveryFeatureEnabled("NDR_STATUS");
  if (!actions && !status) return [];
  return [{
    code: adapter.code, name: adapter.name, quote: adapter.quote,
    ...(actions && { ndrAction: adapter.ndrAction }),
    ...(status && { ndrStatus: adapter.ndrStatus }),
  }];
});
module.exports = require("../services/ndrRouter").createNdrRouter({ Shipment, NdrCase, partnerRegistry, statusMappings: loadStatusMappings() });
