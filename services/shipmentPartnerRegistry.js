const { createPartnerRegistry } = require("./courierQuotationService");
const { createDelhiveryCourierAdapter } = require("./delhiveryCourierAdapter");
const { createMockCourierAdapter } = require("./mockCourierAdapter");
const { isMockCourierAdapterEnabled } = require("../utils/mockEnvironment");
const { isDelhiveryFeatureEnabled } = require("../utils/delhiveryFeatureFlags");

function createShipmentPartnerRegistry({ carrier, mongooseInstance, getEnvironment = () => process.env, allowMock = true } = {}) {
  const getDatabaseName = () => mongooseInstance?.connection?.readyState === 1
    ? mongooseInstance.connection.name
    : null;
  const initialEnv = getEnvironment() || {};
  const mockAllowed = allowMock && isMockCourierAdapterEnabled({ nodeEnv: initialEnv.NODE_ENV, deploymentMode: initialEnv.APP_DEPLOYMENT_MODE, enabled: initialEnv.MOCK_COURIER_ADAPTER_ENABLED, databaseName: getDatabaseName() });
  const mockAdapter = mockAllowed ? createMockCourierAdapter({ getEnvironment, getDatabaseName }) : null;

  const delhivery = carrier && createDelhiveryCourierAdapter(carrier, { getEnvironment });
  const forRead = feature => delhivery && isDelhiveryFeatureEnabled(feature, getEnvironment()) ? delhivery : null;
  const booking = createPartnerRegistry(() => {
    const env = getEnvironment() || {};
    // An explicit mock opt-in always takes precedence. If any safety condition
    // fails, expose no adapter; never fall through to a live carrier adapter.
    // Mock adapters are test fixtures only; never expose them in an application runtime.
    if (mockAllowed) {
      return [mockAdapter];
    }
    if (env.MOCK_COURIER_ADAPTER_ENABLED === "true") return [];
    const adapter = forRead("SHIPMENT_BOOKING") || forRead("SHIPPING_COST");
    return adapter ? [adapter] : [];
  });
  return Object.freeze({
    ...booking,
    quotations: source => {
      const adapter = source === "sample" ? booking.get("MOCK_LOCAL") : forRead("SHIPPING_COST");
      return createPartnerRegistry(adapter ? [adapter] : []);
    },
    tracking: {
      get: code => code === "DELHIVERY" ? forRead("TRACKING") : code === "MOCK_LOCAL" ? booking.get(code) : null,
    },
    canBook: code => code === "DELHIVERY" ? Boolean(forRead("SHIPMENT_BOOKING")) : Boolean(booking.get(code)?.book),
  });
}

module.exports = { createShipmentPartnerRegistry };
