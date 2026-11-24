const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDelhiveryCourierAdapter } = require("./delhiveryCourierAdapter");
const { DELHIVERY_FEATURES } = require("../utils/delhiveryFeatureFlags");
const previousFlags = Object.values(DELHIVERY_FEATURES).map(name => [name, process.env[name]]);
for (const name of Object.values(DELHIVERY_FEATURES)) process.env[name] = "true";
test.after(() => {
  for (const [name, value] of previousFlags) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("Delhivery quote adapter maps requested mode and weight to its existing cost enquiry endpoint", async () => {
  const calls = [];
  const adapter = createDelhiveryCourierAdapter({ get: async (...args) => { calls.push(args); return { data: [{ total_amount: "125.50" }] }; }, post: async () => { throw new Error("not used"); } });
  const result = await adapter.quote({ partnerInput: { originPincode: "111111", destinationPincode: "222222", chargeableWeightKg: 1.25, mode: "SURFACE", paymentType: "COD" } });
  assert.equal(result.amount, 125.5); assert.equal(result.currency, "INR");
  assert.equal(calls[0][0], "/api/kinko/v1/invoice/charges/.json");
  assert.deepEqual(calls[0][1].params, { md: "S", ss: "Delivered", d_pin: "222222", o_pin: "111111", cgm: 1250, pt: "COD" });
});

test("Delhivery quote adapter rejects zero, missing, negative and nonnumeric charges while retaining private response snapshots", async () => {
  for (const body of [
    { total_amount: 0 },
    {},
    { total_amount: -0.01 },
    { total_amount: "invalid" },
  ]) {
    const adapter = createDelhiveryCourierAdapter({ get: async () => ({ data: [body] }), post: async () => ({}) });
    await assert.rejects(
      adapter.quote({ partnerInput: { originPincode: "111111", destinationPincode: "222222", chargeableWeightKg: 1, mode: "SURFACE" } }),
      error => error.code === "INVALID_PROVIDER_QUOTE" && error.providerResponseSnapshot === body,
    );
  }
});

test("Delhivery tracking uses a mocked existing endpoint and preserves provider status text without inventing IDs", async () => {
  const calls = [];
  const adapter = createDelhiveryCourierAdapter({ get: async (...args) => {
    calls.push(args);
    return { data: { ShipmentData: [{ Shipment: { AWB: "MOCK-AWB", Status: { Status: "In Transit", StatusDateTime: "2026-07-02T09:00:00Z", Instructions: "Departed hub" }, Scans: [{ ScanDetail: { Scan: "Pending", ScanType: "UD", StatusCode: "TEST-SCAN", ScannedLocation: "Test Hub", Instructions: "Arrived at hub", ScanDateTime: "2026-07-01T21:00:00Z" } }] } }, { Shipment: { AWB: "OTHER-AWB", Status: { Status: "Delivered", StatusDateTime: "2026-07-02T09:00:00Z" } } }] } };
  }, post: async () => { throw new Error("not used"); } });
  const result = await adapter.track({ waybill: "MOCK-AWB", reference: "" });
  assert.equal(calls[0][0], "/api/v1/packages/json/");
  assert.deepEqual(calls[0][1].params, { waybill: "MOCK-AWB", ref_ids: "" });
  assert.deepEqual(result.events.map(event => event.status), ["In Transit", "Pending"]);
  assert.equal(result.events[1].location, "Test Hub");
  assert.equal(result.events[1].statusCode, "TEST-SCAN");
  assert.equal(result.events[1].statusType, "UD");
  assert.equal(result.events.some(event => Object.hasOwn(event, "providerEventId")), false);
});

test("Delhivery tracking reports sanitized diagnostics for malformed or mismatched responses", async () => {
  const bodies = [
    { data: { unexpected: true } },
    { data: { ShipmentData: [{ Shipment: { AWB: "OTHER", Status: { Status: "Delivered", StatusDateTime: "2026-07-02T09:00:00Z" } } }] } },
    { data: { ShipmentData: [{ Shipment: { AWB: "1234567890", Status: { Status: "Delivered", StatusDateTime: "2026-07-02T09:00:00" } } }] } },
  ];
  for (const response of bodies) {
    const adapter = createDelhiveryCourierAdapter({ get: async () => ({ ...response, status: 200 }), post: async () => ({}) });
    await assert.rejects(adapter.track({ waybill: "1234567890" }), error => {
      assert.equal(error.code, "INVALID_TRACKING_RESPONSE");
      assert.equal(error.trackingDiagnostics.httpStatus, 200);
      assert.equal(typeof error.trackingDiagnostics.rowCount, "number");
      assert.equal(typeof error.trackingDiagnostics.awbMatchCount, "number");
      assert.equal(typeof error.trackingDiagnostics.validEventCount, "number");
      assert.equal(typeof error.trackingDiagnostics.timestampRejectedCount, "number");
      assert.equal(Object.hasOwn(error.trackingDiagnostics, "responseBody"), false);
      return true;
    });
  }
});

test("Delhivery tracking accepts ISO timestamps and reports timezone-less/invalid timestamp reasons", async () => {
  const adapter = createDelhiveryCourierAdapter({ get: async () => ({ status: 200, data: { ShipmentData: [{ Shipment: { AWB: "1234567890", Status: { Status: "Delivered", StatusDateTime: "2026-07-02T09:00:00" }, Scans: [{ ScanDetail: { Scan: "Invalid", ScanDateTime: "not-a-date" } }] } }] } }), post: async () => ({}) }, { getEnvironment: () => ({ DELHIVERY_TRACKING_ENABLED: "true", DELHIVERY_TRACKING_UTC_OFFSET: "+05:30" }) });
  const result = await adapter.track({ waybill: "1234567890" });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].occurredAt, "2026-07-02T09:00:00+05:30");

  const rejected = createDelhiveryCourierAdapter({ get: async () => ({ status: 200, data: { ShipmentData: [{ Shipment: { AWB: "1234567890", Status: { Status: "Delivered", StatusDateTime: "not-a-date" } } }] } }), post: async () => ({}) });
  await assert.rejects(rejected.track({ waybill: "1234567890" }), error => {
    const item = error.trackingDiagnostics.timestampDiagnostics[0];
    assert.deepEqual(item, { field: "Shipment.Status.StatusDateTime", type: "string", category: "unsupported", timezonePresent: false, rejectionReason: "timezone missing" });
    return true;
  });
});

test("Delhivery Scan Push normalizes a documented payload using the configured timestamp offset", () => {
  const carrier = { get: () => assert.fail("Webhook must not call carrier"), post: () => assert.fail("Webhook must not call carrier") };
  const shipment = { AWB: "1234567890", ReferenceNo: "TEST-1", NSLCode: "X-UCI", Status: { Status: "Manifested", StatusDateTime: "2026-07-02T09:00:00.000", StatusLocation: "Test Hub", StatusType: "UD", Instructions: "Shipment created" } };
  const unconfigured = createDelhiveryCourierAdapter(carrier, { getEnvironment: () => ({}) });
  assert.deepEqual(unconfigured.normalizeWebhook({ Shipment: shipment }).events, []);
  const adapter = createDelhiveryCourierAdapter(carrier, { getEnvironment: () => ({ DELHIVERY_TRACKING_UTC_OFFSET: "+05:30" }) });
  const result = adapter.normalizeWebhook({ Shipment: shipment });
  assert.equal(result.waybill, shipment.AWB);
  assert.equal(result.reference, shipment.ReferenceNo);
  assert.deepEqual(result.events[0], { status: "Manifested", occurredAt: "2026-07-02T09:00:00.000+05:30", location: "Test Hub", description: "Shipment created", statusCode: "X-UCI", statusType: "UD" });
});

test("AWB recovery uses a read-only exact reference match and never authorizes retry", async () => {
  const providerReference = "CMS-" + "a".repeat(32);
  const calls = [];
  let rows = [];
  let success = true;
  const adapter = createDelhiveryCourierAdapter({
    get: async (...args) => { calls.push(args); return { data: { success, ShipmentData: rows } }; },
    post: async () => assert.fail("Recovery must not manifest"),
  }, { getEnvironment: () => ({ DELHIVERY_TRACKING_ENABLED: "true" }) });
  assert.deepEqual(await adapter.reconcile({ providerReference: "LEGACY-REF" }), { status: "UNKNOWN" });
  assert.equal(calls.length, 0);
  assert.deepEqual(await adapter.reconcile({ providerReference }), { status: "UNKNOWN" });
  rows = [{ Shipment: { ReferenceNo: "WRONG", AWB: "1234567890" } }];
  assert.deepEqual(await adapter.reconcile({ providerReference }), { status: "UNKNOWN" });
  rows = [{ Shipment: { ReferenceNo: providerReference, AWB: "1234567890" } }];
  assert.equal((await adapter.reconcile({ providerReference })).waybill, "1234567890");
  assert.deepEqual(calls[0], ["/api/v1/packages/json/", { params: { waybill: "", ref_ids: providerReference } }]);
  success = false;
  assert.deepEqual(await adapter.reconcile({ providerReference }), { status: "UNKNOWN" });
  success = true;
  rows.push(rows[0]);
  assert.deepEqual(await adapter.reconcile({ providerReference }), { status: "UNKNOWN" });
});

test("Delhivery NDR action and status operations use only mocked carrier responses", async () => {
  const calls = [];
  const adapter = createDelhiveryCourierAdapter({
    get: async (...args) => { calls.push(["GET", ...args]); return { data: { status: "mock status" } }; },
    post: async (...args) => { calls.push(["POST", ...args]); return { data: { success: true, upl_id: "UPL-MOCK-1" } }; },
  });
  const submitted = await adapter.ndrAction({ waybill: "MOCK-AWB", action: "RE-ATTEMPT" });
  assert.equal(submitted.providerRequestId, "UPL-MOCK-1");
  assert.equal(calls[0][0], "POST");
  assert.equal(calls[0][1], "/api/p/update");
  assert.deepEqual(calls[0][2], { data: [{ waybill: "MOCK-AWB", act: "RE-ATTEMPT" }] });
  const status = await adapter.ndrStatus({ uplId: "UPL-MOCK-1" });
  assert.deepEqual(status.responseSnapshot, { status: "mock status" });
  assert.equal(calls[1][1], "/api/cmu/get_bulk_upl/UPL-MOCK-1");
});

test("NDR status can run with the mutation gate closed, and a missing upload ID is ambiguous", async () => {
  let calls = 0;
  const carrier = { get: async () => { calls++; return { data: { pending: true } }; }, post: async () => { calls++; return { data: { success: true } }; } };
  const readOnly = createDelhiveryCourierAdapter(carrier, { getEnvironment: () => ({ DELHIVERY_NDR_STATUS_ENABLED: "true" }) });
  assert.deepEqual((await readOnly.ndrStatus({ uplId: "UPL-TEST" })).responseSnapshot, { pending: true });
  await assert.rejects(readOnly.ndrAction({ waybill: "1234567890", action: "RE-ATTEMPT" }), error => error.code === "DELHIVERY_FEATURE_DISABLED");
  assert.equal(calls, 1);
  const write = createDelhiveryCourierAdapter(carrier, { getEnvironment: () => ({ DELHIVERY_NDR_OPERATIONS_ENABLED: "true" }) });
  await assert.rejects(write.ndrAction({ waybill: "1234567890", action: "RE-ATTEMPT" }), error => error.outcome === "AMBIGUOUS");
  assert.equal(calls, 2);
});

test("Delhivery booking adapter sends the selected service to the existing create contract and returns an AWB", async () => {
  const calls = [];
  const adapter = createDelhiveryCourierAdapter({ get: async () => ({}), post: async (...args) => { calls.push(args); return { data: { success: true, packages: [{ waybill: "MOCK-AWB-1", status: "Success" }] } }; } });
  const result = await adapter.book({ draftSnapshot: { formData: { reference: "DUMMY-ORDER", customer: "Dummy Recipient", pincode: "222222", payment: "COD", value: "50", mode: "Express", warehouse: "TEST-HUB", weight: "0.5" } }, selectedQuote: { mode: "SURFACE" } });
  assert.equal(result.waybill, "MOCK-AWB-1");
  assert.equal(calls[0][0], "/api/cmu/create.json");
  const encoded = new URLSearchParams(calls[0][1]).get("data"); const payload = JSON.parse(encoded);
  assert.equal(payload.shipments[0].order, "DUMMY-ORDER");
  assert.equal(payload.shipments[0].shipping_mode, "Surface");
  assert.equal(payload.shipments[0].cod_amount, "50");
  assert.deepEqual(calls[0][2].headers, { "Content-Type": "application/x-www-form-urlencoded" });
});

test("Delhivery adapter refuses invalid quote inputs without making an API request", async () => {
  let calls = 0;
  const adapter = createDelhiveryCourierAdapter({ get: async () => { calls++; return { data: [] }; }, post: async () => { calls++; return {}; } });
  await assert.rejects(adapter.quote({ partnerInput: {} }), /Valid origin/);
  assert.equal(calls, 0);
});

test("explicit mocked provider rejection is definitive while transport failures stay ambiguous", async () => {
  const rejectedAdapter = createDelhiveryCourierAdapter({ get: async () => ({}), post: async () => ({ data: { success: false, status: "failed" } }) });
  await assert.rejects(rejectedAdapter.book({ draftSnapshot: { formData: {} }, selectedQuote: {} }), error => error.definitive === true && error.outcome === "REJECTED");
  const timeoutAdapter = createDelhiveryCourierAdapter({ get: async () => ({}), post: async () => { throw new Error("mock timeout"); } });
  await assert.rejects(timeoutAdapter.book({ draftSnapshot: { formData: {} }, selectedQuote: {} }), error => error.message === "mock timeout" && error.definitive !== true);
});

test("Delhivery update, cancellation and e-waybill adapter methods preserve existing edit payloads", async () => {
  const calls = [];
  const adapter = createDelhiveryCourierAdapter({ get: async () => ({}), post: async (...args) => { calls.push(args); return { data: { status: true } }; } });
  await adapter.updateShipment({ waybill: "1234567890", name: "Recipient", city: "Delhi", ignored: "drop" });
  await adapter.cancelShipment({ waybill: "1234567890" });
  await adapter.updateEwaybill({ waybill: "1234567890", ewbn: "EWB-1" });
  assert.deepEqual(calls.map(([path, body]) => [path, body]), [
    ["/api/p/edit", { waybill: "1234567890", name: "Recipient", city: "Delhi" }],
    ["/api/p/edit", { waybill: "1234567890", cancellation: "true" }],
    ["/api/p/edit", { waybill: "1234567890", ewbn: "EWB-1" }],
  ]);
});

test("an empty edit acknowledgement cannot update local shipment state", async () => {
  const adapter = createDelhiveryCourierAdapter({ get: async () => ({}), post: async () => ({ data: {} }) });
  await assert.rejects(adapter.cancelShipment({ waybill: "1234567890" }), error => error.outcome === "AMBIGUOUS");
});

test("pickup creation uses the existing request endpoint, while disabled configuration and invalid input make no request", async () => {
  const calls = [];
  const carrier = { get: async () => ({}), post: async (...args) => { calls.push(args); return { data: { pickup_id: "PICKUP-1", status: true } }; } };
  const enabled = createDelhiveryCourierAdapter(carrier);
  const request = { pickup_date: "2030-01-01", pickup_time: "10:00", pickup_location: "Hub", expected_package_count: 1 };
  const result = await enabled.createPickup({ request });
  assert.equal(result.carrierRequestId, "PICKUP-1");
  assert.deepEqual(calls[0], ["/fm/request/new/", request, { headers: { "Content-Type": "application/json" } }]);
  await assert.rejects(enabled.createPickup({ request: null }));
  const disabled = createDelhiveryCourierAdapter(carrier, { getEnvironment: () => ({ DELHIVERY_PICKUP_CREATION_ENABLED: "false" }) });
  await assert.rejects(disabled.createPickup({ request }), error => error.code === "DELHIVERY_FEATURE_DISABLED");
  assert.equal(calls.length, 1);
});

test("missing pickup IDs and partial-save booking replies remain ambiguous", async () => {
  let response = { success: true };
  const adapter = createDelhiveryCourierAdapter({ get: async () => ({}), post: async () => ({ data: response }) });
  await assert.rejects(adapter.createPickup({ request: { pickup_date: "2030-01-01" } }), error => error.outcome === "AMBIGUOUS");
  response = { message: "Package might have been partially saved", data: { success: false, packages: [{ status: "failed" }] } };
  await assert.rejects(adapter.book({}), error => error.outcome === "AMBIGUOUS" && error.definitive === false);
});

test("serviceability reads the provider's flag for the selected payment type", async () => {
  const calls = [];
  const adapter = createDelhiveryCourierAdapter({
    get: async (...args) => {
      calls.push(args);
      return { data: { delivery_codes: [{ postal_code: { pin: "110001", pre_paid: "Y", cod: "N", pickup: "Y" } }] } };
    },
    post: async () => assert.fail("No carrier mutation should be sent"),
  });
  assert.equal(await adapter.checkServiceability({ pincode: "110001", paymentType: "Prepaid" }), true);
  assert.equal(await adapter.checkServiceability({ pincode: "110001", paymentType: "COD" }), false);
  assert.deepEqual(calls[0], ["/c/api/pin-codes/json/", { params: { filter_codes: "110001" }, timeout: 10000 }]);
});

test("mutation transport failures remain ambiguous and are not retried", async () => {
  let calls = 0;
  const adapter = createDelhiveryCourierAdapter({ get: async () => ({}), post: async () => { calls += 1; throw new Error("mock timeout"); } });
  await assert.rejects(adapter.cancelShipment({ waybill: "1234567890" }), error => error.outcome === "AMBIGUOUS");
  assert.equal(calls, 1);
});

test("all provider adapter operations fail closed after Delhivery is disabled", async () => {
  let calls = 0;
  const adapter = createDelhiveryCourierAdapter({ get: async () => { calls++; return { data: [] }; }, post: async () => { calls++; return { data: {} }; } }, { getEnvironment: () => ({}) });
  const operations = [
    () => adapter.quote({ partnerInput: { originPincode: "111111", destinationPincode: "222222", chargeableWeightKg: 1, mode: "SURFACE" } }),
    () => adapter.track({ waybill: "1234567890" }),
    () => adapter.book({ draftSnapshot: { formData: {} }, selectedQuote: {} }),
    () => adapter.ndrAction({ waybill: "1234567890", action: "RE-ATTEMPT" }),
    () => adapter.ndrStatus({ uplId: "UPL-1" }),
    () => adapter.updateShipment({ waybill: "1234567890", city: "Delhi" }),
    () => adapter.cancelShipment({ waybill: "1234567890" }),
    () => adapter.updateEwaybill({ waybill: "1234567890", ewbn: "EWB-1" }),
    () => adapter.createPickup({ request: { pickup_date: "2030-01-01" } }),
  ];
  for (const operation of operations) await assert.rejects(operation, error => error.code === "DELHIVERY_FEATURE_DISABLED");
  assert.equal(calls, 0);
});

test("each adapter operation is independently gated and enabling one feature never enables another", async () => {
  let calls = 0;
  const carrier = { get: async () => { calls++; return { data: [{ total_amount: 1 }] }; }, post: async () => { calls++; return { data: { success: true, packages: [{ waybill: "MOCK-WB" }] } }; } };
  const environment = { DELHIVERY_SHIPPING_COST_ENABLED: "true" };
  const adapter = createDelhiveryCourierAdapter(carrier, { getEnvironment: () => environment });
  await adapter.quote({ partnerInput: { originPincode: "111111", destinationPincode: "222222", chargeableWeightKg: 1, mode: "SURFACE" } });
  await assert.rejects(adapter.book({ draftSnapshot: { formData: {} }, selectedQuote: {} }), { code: "DELHIVERY_FEATURE_DISABLED" });
  await assert.rejects(adapter.track({ waybill: "1234567890" }), { code: "DELHIVERY_FEATURE_DISABLED" });
  assert.equal(calls, 1);
});
