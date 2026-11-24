const { readDelhiveryConfiguration } = require("./delhiveryConfiguration");

const DELHIVERY_FEATURES = Object.freeze({
  PINCODE_SERVICEABILITY: "DELHIVERY_PINCODE_SERVICEABILITY_ENABLED",
  HEAVY_PINCODE_SERVICEABILITY: "DELHIVERY_HEAVY_PINCODE_SERVICEABILITY_ENABLED",
  SHIPPING_COST: "DELHIVERY_SHIPPING_COST_ENABLED",
  EXPECTED_TAT: "DELHIVERY_EXPECTED_TAT_ENABLED",
  WAYBILL_ALLOCATION: "DELHIVERY_WAYBILL_ALLOCATION_ENABLED",
  WAREHOUSE_CREATE: "DELHIVERY_WAREHOUSE_CREATE_ENABLED",
  WAREHOUSE_UPDATE: "DELHIVERY_WAREHOUSE_UPDATE_ENABLED",
  SHIPMENT_BOOKING: "DELHIVERY_SHIPMENT_BOOKING_ENABLED",
  SHIPMENT_UPDATE: "DELHIVERY_SHIPMENT_UPDATE_ENABLED",
  SHIPMENT_CANCELLATION: "DELHIVERY_SHIPMENT_CANCELLATION_ENABLED",
  EWAYBILL: "DELHIVERY_EWAYBILL_ENABLED",
  PICKUP_CREATION: "DELHIVERY_PICKUP_CREATION_ENABLED",
  PICKUP_STATUS: "DELHIVERY_PICKUP_STATUS_ENABLED",
  TRACKING: "DELHIVERY_TRACKING_ENABLED",
  LABELS: "DELHIVERY_LABELS_ENABLED",
  DOCUMENTS: "DELHIVERY_DOCUMENTS_ENABLED",
  REVERSE_ORDERS: "DELHIVERY_REVERSE_ORDERS_ENABLED",
  NDR_OPERATIONS: "DELHIVERY_NDR_OPERATIONS_ENABLED",
  NDR_STATUS: "DELHIVERY_NDR_STATUS_ENABLED",
  TRACKING_WEBHOOK: "DELHIVERY_TRACKING_WEBHOOK_ENABLED",
});

const FEATURE_LABELS = Object.freeze({
  PINCODE_SERVICEABILITY: "pincode serviceability",
  HEAVY_PINCODE_SERVICEABILITY: "heavy pincode serviceability",
  SHIPPING_COST: "shipping cost enquiries",
  EXPECTED_TAT: "expected delivery time enquiries",
  WAYBILL_ALLOCATION: "waybill allocation",
  WAREHOUSE_CREATE: "warehouse creation",
  WAREHOUSE_UPDATE: "warehouse updates",
  SHIPMENT_BOOKING: "shipment booking",
  SHIPMENT_UPDATE: "shipment updates",
  SHIPMENT_CANCELLATION: "shipment cancellation",
  EWAYBILL: "e-waybill operations",
  PICKUP_CREATION: "pickup creation",
  PICKUP_STATUS: "pickup status synchronization",
  TRACKING: "tracking synchronization",
  LABELS: "label retrieval",
  DOCUMENTS: "document retrieval",
  REVERSE_ORDERS: "reverse order creation",
  NDR_OPERATIONS: "NDR operations",
  NDR_STATUS: "NDR status lookup",
  TRACKING_WEBHOOK: "tracking webhook",
});

const READ_ONLY_FEATURES = new Set([
  "PINCODE_SERVICEABILITY", "HEAVY_PINCODE_SERVICEABILITY", "SHIPPING_COST",
  "EXPECTED_TAT", "PICKUP_STATUS", "TRACKING", "LABELS", "DOCUMENTS", "NDR_STATUS",
]);

// Capabilities that do not have a verified provider contract must remain
// explicitly enabled; all other capabilities can use production defaults when
// the validated Delhivery configuration is present. An explicit "false" always
// remains a safety override.
const DEFAULT_DISABLED_FEATURES = new Set(["PICKUP_STATUS"]);

function isDelhiveryFeatureEnabled(feature, environment = process.env) {
  const envName = DELHIVERY_FEATURES[feature];
  if (!envName) return false;
  if (environment?.[envName] === "false") return false;
  const configured = Boolean(environment && readDelhiveryConfiguration(environment));
  if (environment?.[envName] !== "true") {
    if (environment?.APP_DEPLOYMENT_MODE !== "production" || !configured || DEFAULT_DISABLED_FEATURES.has(feature)) return false;
    if (feature === "TRACKING_WEBHOOK" && !environment.DELHIVERY_WEBHOOK_AUTHORIZATION) return false;
  }
  if (READ_ONLY_FEATURES.has(feature) || feature === "TRACKING_WEBHOOK") return true;
  return environment.APP_DEPLOYMENT_MODE !== "uat" && environment.MOCK_COURIER_ADAPTER_ENABLED !== "true";
}

function anyDelhiveryFeatureEnabled(environment = process.env) {
  return Object.keys(DELHIVERY_FEATURES).some(feature => isDelhiveryFeatureEnabled(feature, environment));
}

function delhiveryFeatureDisabledResponse(res, feature) {
  if (res.locals) res.locals.safeErrorCode = "DELHIVERY_FEATURE_DISABLED";
  const label = FEATURE_LABELS[feature] || "This Delhivery operation";
  return res.status(503).json({
    success: false,
    code: "DELHIVERY_FEATURE_DISABLED",
    message: `Delhivery ${label} feature is disabled. No provider request was sent.`,
  });
}

function requireDelhiveryFeature(feature, getEnvironment = () => process.env) {
  return (req, res, next) => isDelhiveryFeatureEnabled(feature, getEnvironment())
    ? next()
    : delhiveryFeatureDisabledResponse(res, feature);
}

module.exports = {
  DELHIVERY_FEATURES,
  FEATURE_LABELS,
  isDelhiveryFeatureEnabled,
  anyDelhiveryFeatureEnabled,
  delhiveryFeatureDisabledResponse,
  requireDelhiveryFeature,
};

