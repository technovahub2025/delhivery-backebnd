const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mapProviderStatus, validateMappings, loadStatusMappings } = require("./providerStatusMappings");

test("normalizes configured provider labels and preserves unknown labels as unmapped", () => {
  const config = validateMappings({ TEST: { shipment: { "In Transit": "IN_TRANSIT" }, rtoTrigger: { "Return to Origin": "RTO_TRIGGER" }, rto: { "Return Received": "COMPLETED" } } });
  assert.equal(mapProviderStatus("test", "shipment", "in_transit", config), "IN_TRANSIT");
  assert.equal(mapProviderStatus("TEST", "rtoTrigger", "Return to Origin", config), "RTO_TRIGGER");
  assert.equal(mapProviderStatus("TEST", "rto", "Unknown carrier phrase", config), null);
  const extended = validateMappings({ TEST: { shipment: { "Out for delivery": "OUT_FOR_DELIVERY", Delayed: "DELAYED" }, pickup: { Assigned: "ASSIGNED" } } });
  assert.equal(mapProviderStatus("TEST", "shipment", "Out for delivery", extended), "OUT_FOR_DELIVERY");
  assert.equal(mapProviderStatus("TEST", "pickup", "Assigned", extended), "ASSIGNED");
});

test("rejects unsupported canonical states and malformed mapping JSON", () => {
  assert.throws(() => validateMappings({ MOCK: { shipment: { Delivered: "SOMETHING_INVENTED" } } }), /Invalid shipment mapping/);
  assert.throws(() => loadStatusMappings("not-json"), /valid JSON/);
});
