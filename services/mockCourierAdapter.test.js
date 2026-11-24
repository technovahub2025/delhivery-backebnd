const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const { isMockCourierAdapterEnabled, createMockCourierAdapter, createTestReference } = require("./mockCourierAdapter");
const { createShipmentPartnerRegistry } = require("./shipmentPartnerRegistry");

const safeConfiguration = { nodeEnv: "development", enabled: "true", databaseName: "courier_testing" };
const carrier = { get() { throw new Error("live carrier must not be called"); }, post() { throw new Error("live carrier must not be called"); } };

test("mock adapter requires explicit development/test opt-in and the exact testing database", () => {
  assert.equal(isMockCourierAdapterEnabled(safeConfiguration), true);
  assert.equal(isMockCourierAdapterEnabled({ ...safeConfiguration, nodeEnv: "production" }), false);
  assert.equal(isMockCourierAdapterEnabled({ ...safeConfiguration, nodeEnv: "staging" }), false);
  assert.equal(isMockCourierAdapterEnabled({ ...safeConfiguration, nodeEnv: undefined }), false);
  assert.equal(isMockCourierAdapterEnabled({ ...safeConfiguration, enabled: "false" }), false);
  assert.equal(isMockCourierAdapterEnabled({ ...safeConfiguration, enabled: undefined }), false);
  assert.equal(isMockCourierAdapterEnabled({ ...safeConfiguration, databaseName: "courier_live" }), false);
});

test("mock adapter is not exposed in production or outside courier_testing, even if Delhivery is enabled", () => {
  for (const { nodeEnv, databaseName } of [
    { nodeEnv: "production", databaseName: "courier_testing" },
    { nodeEnv: "development", databaseName: "other_database" },
    { nodeEnv: "test", databaseName: "courier_live" },
  ]) {
    const environment = { NODE_ENV: nodeEnv, MOCK_COURIER_ADAPTER_ENABLED: "true", DELHIVERY_SHIPPING_COST_ENABLED: "true", DELHIVERY_SHIPMENT_BOOKING_ENABLED: "true" };
    const registry = createShipmentPartnerRegistry({ carrier, mongooseInstance: { connection: { readyState: 1, name: databaseName } }, getEnvironment: () => environment });
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.get("MOCK_LOCAL"), null);
    assert.equal(registry.get("DELHIVERY"), null, "invalid mock opt-in must not fall through to the live adapter");
  }
});

test("mock adapter remains unavailable until the courier_testing database connection is ready", () => {
  const environment = { NODE_ENV: "development", MOCK_COURIER_ADAPTER_ENABLED: "true" };
  const registry = createShipmentPartnerRegistry({ carrier, mongooseInstance: { connection: { readyState: 0, name: "courier_testing" } }, getEnvironment: () => environment });
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.get("MOCK_LOCAL"), null);
});

test("valid mock opt-in exposes only the mock adapter and preserves explicit Delhivery opt-in when mock is off", () => {
  const environment = { NODE_ENV: "development", MOCK_COURIER_ADAPTER_ENABLED: "true", DELHIVERY_SHIPPING_COST_ENABLED: "true", DELHIVERY_SHIPMENT_BOOKING_ENABLED: "true" };
  const mongooseInstance = { connection: { readyState: 1, name: "courier_testing" } };
  const mockRegistry = createShipmentPartnerRegistry({ carrier, mongooseInstance, getEnvironment: () => environment });
  assert.deepEqual(mockRegistry.list().map(adapter => adapter.code), ["MOCK_LOCAL"]);
  assert.equal(mockRegistry.get("DELHIVERY"), null);

  environment.MOCK_COURIER_ADAPTER_ENABLED = "false";
  const carrierRegistry = createShipmentPartnerRegistry({ carrier, mongooseInstance, getEnvironment: () => environment });
  assert.deepEqual(carrierRegistry.list().map(adapter => adapter.code), ["DELHIVERY"]);
});

test("MOCK_LOCAL registry quotation never falls through to the Delhivery carrier", async () => {
  let carrierRequests = 0;
  const guardedCarrier = {
    get() { carrierRequests += 1; throw new Error("unexpected carrier request"); },
    post() { carrierRequests += 1; throw new Error("unexpected carrier request"); },
  };
  const environment = { NODE_ENV: "test", MOCK_COURIER_ADAPTER_ENABLED: "true", DELHIVERY_SHIPPING_COST_ENABLED: "true", DELHIVERY_SHIPMENT_BOOKING_ENABLED: "true" };
  const registry = createShipmentPartnerRegistry({
    carrier: guardedCarrier,
    mongooseInstance: { connection: { readyState: 1, name: "courier_testing" } },
    getEnvironment: () => environment,
  });
  assert.deepEqual(registry.list().map(adapter => adapter.code), ["MOCK_LOCAL"]);
  const [adapter] = registry.list();
  const quote = await adapter.quote({ draftId: "draft-test", partnerInput: { mode: "SURFACE" } });
  assert.equal(quote.estimateSnapshot.networkRequestMade, false);
  assert.equal(carrierRequests, 0);
});

test("live quotes and tracking are independent of mock booking, and samples require explicit choice", async () => {
  const requests = [];
  const environment = {
    APP_DEPLOYMENT_MODE: "uat", MOCK_COURIER_ADAPTER_ENABLED: "true",
    DELHIVERY_SHIPPING_COST_ENABLED: "true", DELHIVERY_TRACKING_ENABLED: "true",
    DELHIVERY_SHIPMENT_BOOKING_ENABLED: "true",
  };
  const registry = createShipmentPartnerRegistry({
    carrier: {
      async get(path) { requests.push(path); throw Object.assign(new Error("Private provider message"), { response: { status: 401 } }); },
      async post() { assert.fail("No carrier mutation may execute"); },
    },
    getEnvironment: () => environment,
    mongooseInstance: { connection: { readyState: 1, name: "courier_testing" } },
  });
  const { requestPartnerQuotes } = require("./courierQuotationService");
  const context = { draftId: "read-test", partnerInput: { originPincode: "110001", destinationPincode: "400001", chargeableWeightKg: 1, mode: "SURFACE" } };
  const live = await requestPartnerQuotes(registry.quotations("live"), context);
  assert.deepEqual(live.quotes, []);
  assert.match(live.unavailable[0].reason, /carrier HTTP 401/);
  assert.equal(registry.canBook("DELHIVERY"), false);
  assert.equal(registry.tracking.get("DELHIVERY").code, "DELHIVERY");
  const sample = await requestPartnerQuotes(registry.quotations("sample"), context);
  assert.equal(sample.quotes[0].provenance, "LOCAL_MOCK");
  assert.equal((await registry.get("MOCK_LOCAL").book(context)).record.mockOnly, true);
  assert.deepEqual(requests, ["/api/kinko/v1/invoice/charges/.json"]);
  environment.DELHIVERY_TRACKING_ENABLED = "false";
  environment.DELHIVERY_SHIPPING_COST_ENABLED = "false";
  assert.equal(registry.tracking.get("DELHIVERY"), null);
  assert.deepEqual(registry.quotations("live").list(), []);
});

test("mock quote and booking make no network calls and return deterministic no-AWB test data", async () => {
  const environment = { NODE_ENV: "test", MOCK_COURIER_ADAPTER_ENABLED: "true" };
  const adapter = createMockCourierAdapter({ getEnvironment: () => environment, getDatabaseName: () => "courier_testing" });
  const originalFetch = global.fetch;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  let networkCalls = 0;
  const forbiddenNetworkCall = () => { networkCalls += 1; throw new Error("network request is forbidden in mock adapter tests"); };
  global.fetch = forbiddenNetworkCall;
  http.request = forbiddenNetworkCall;
  https.request = forbiddenNetworkCall;
  try {
    const context = { draftId: "draft-123", partnerInput: { mode: "SURFACE" } };
    const firstQuote = await adapter.quote(context);
    const secondQuote = await adapter.quote(context);
    const result = await adapter.book({ draftSnapshot: { formData: { reference: "TEST-ORDER-7" } } });
    assert.equal(firstQuote.estimateSnapshot.testReference, createTestReference("QUOTE", "draft-123"));
    assert.equal(secondQuote.estimateSnapshot.testReference, firstQuote.estimateSnapshot.testReference);
    assert.equal(firstQuote.estimateSnapshot.networkRequestMade, false);
    assert.equal(result.bookingStatus, "BOOKED_AWB_PENDING");
    assert.equal(result.record.mockTestReference, createTestReference("BOOKING", "TEST-ORDER-7"));
    assert.equal(result.record.awbGenerated, false);
    assert.equal(result.record.waybill, "");
    assert.equal(Object.hasOwn(result, "waybill"), false);
    assert.equal(networkCalls, 0);
  } finally {
    global.fetch = originalFetch;
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
  }
});

test("mock adapter rechecks every operation and fails closed if its environment changes", async () => {
  const environment = { NODE_ENV: "development", MOCK_COURIER_ADAPTER_ENABLED: "true" };
  let databaseName = "courier_testing";
  const adapter = createMockCourierAdapter({ getEnvironment: () => environment, getDatabaseName: () => databaseName });
  environment.MOCK_COURIER_ADAPTER_ENABLED = "false";
  await assert.rejects(adapter.quote({ draftId: "draft-1" }), { code: "MOCK_COURIER_ADAPTER_DISABLED" });
  environment.MOCK_COURIER_ADAPTER_ENABLED = "true";
  databaseName = "courier_live";
  await assert.rejects(adapter.book({ draftSnapshot: { formData: { reference: "TEST" } } }), { code: "MOCK_COURIER_ADAPTER_DISABLED" });
});
test("opt-in sample AWB and scans are tied to the mock shipment and never to a real waybill", async () => {
  const strictAssert = require("node:assert/strict");
  const { createMockCourierAdapter } = require("./mockCourierAdapter");
  const environment = { NODE_ENV: "test", MOCK_COURIER_ADAPTER_ENABLED: "true", MOCK_COURIER_SAMPLE_AWB_ENABLED: "true", MOCK_COURIER_EXPRESS_SAMPLE: "65.50" };
  const adapter = createMockCourierAdapter({ getEnvironment: () => environment, getDatabaseName: () => "courier_testing" });
  const quote = await adapter.quote({ partnerInput: { mode: "EXPRESS" } });
  strictAssert.equal(quote.amount, 65.5);
  strictAssert.equal(quote.provenance, "LOCAL_MOCK");
  const booking = await adapter.book({ draftSnapshot: { formData: { reference: "sample-order" } } });
  strictAssert.match(booking.waybill, /^SAMPLE-AWB-/);
  strictAssert.equal(booking.receipt.waybillGenerated, false);
  const shipmentSnapshot = { record: booking.record, createdAt: new Date("2026-10-01T00:00:00Z") };
  strictAssert.equal((await adapter.track({ waybill: booking.waybill, shipmentSnapshot })).events[0].status, "Sample pickup pending");
  await strictAssert.rejects(adapter.track({ waybill: "123456789", shipmentSnapshot }), /unavailable/);
});
