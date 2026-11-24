const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const makeRouter = require("../services/shipmentQuoteRouter");
const { createPartnerRegistry, createDraftInputFingerprint } = require("../services/courierQuotationService");
const { createShipmentPartnerRegistry } = require("../services/shipmentPartnerRegistry");
const { createMockCourierAdapter, createTestReference } = require("../services/mockCourierAdapter");
const { getDashboardOverview } = require("../services/dashboardService");

test("quote performance counts real owned history and keeps unmapped outcomes visible", async () => {
  const fake = {
    aggregate(pipeline) {
      assert.deepEqual(pipeline[0].$match, { owner: "owner-a", state: "saved", kind: { $in: ["forward", null] }, "record.mockOnly": { $ne: true } });
      assert.deepEqual(pipeline[2].$match.partner.$in, ["DELHIVERY"]);
      return { option: async () => [
        { _id: { partner: "DELHIVERY", rawStatus: "Delivered" }, count: 3 },
        { _id: { partner: "DELHIVERY", rawStatus: "Delayed" }, count: 1 },
        { _id: { partner: "DELHIVERY", rawStatus: "Unknown" }, count: 2 },
      ] };
    },
  };
  const result = await makeRouter.summarizeQuotePartnerPerformance(fake, "owner-a", [
    { partnerCode: "DELHIVERY", partnerName: "Delhivery" },
    { partnerCode: "MOCK_LOCAL", partnerName: "Sample" },
  ], { DELHIVERY: { shipment: { delivered: "DELIVERED", delayed: "DELAYED" } } });
  assert.deepEqual(result, [{ code: "DELHIVERY", name: "Delhivery", shipmentCount: 6, mappedCount: 4, deliveredCount: 3, exceptionCount: 1 }]);
});

async function fixture(t, adapters, { includeProtectedDraft = false, environment = {}, injectedPartnerRegistry } = {}) {
  const original = process.env.JWT_SECRET; process.env.JWT_SECRET = "quote-tests-only";
  const id = "aaaaaaaaaaaaaaaaaaaaaaaa"; const otherId = "bbbbbbbbbbbbbbbbbbbbbbbb"; const warehouseId = "eeeeeeeeeeeeeeeeeeeeeeee"; const foreignWarehouseId = "ffffffffffffffffffffffff";
  const warehouse = { _id: warehouseId, owner: "owner-a", name: "Test hub", registrationStatus: "REGISTERED", details: { address: "Registered test address", pin: "111111", contact_name: "Test contact", phone: "9000000001" } };
  const foreignWarehouse = { _id: foreignWarehouseId, owner: "owner-b", name: "Foreign hub", registrationStatus: "REGISTERED", details: { address: "Foreign Road", pin: "222222", phone: "9000000002" } };
  const row = { _id: id, owner: "owner-a", reference: "DRAFT-TEST", state: "draft", kind: "forward", updatedAt: new Date("2026-01-01T00:00:00.000Z"), draftData: { formData: { reference: "DUMMY-REF-1", warehouse: "Test hub", warehouseId, customer: "Dummy Recipient", address: "1 Test Road", destination: "Test City", state: "Test State", phone: "9000000000", mode: "Surface", payment: "Prepaid", value: "250", pincode: "222222", pincodeServiceable: true, chargeableWeightKg: 1 }, customerSnapshot: { id: "customer-test", category: "WALK_IN", displayName: "Dummy Recipient", rateCardId: "card-test" }, rateCardSnapshot: { id: "card-test", scope: "WALK_IN_STANDARD", customerId: null, name: "Dummy Walk-in Standard", version: 1 }, pickupSnapshot: {}, shipperSnapshot: { companyName: "Test Shipper", pincode: "111111" }, consigneeSnapshot: { companyName: "Dummy Recipient", pincode: "222222" }, destinationSnapshot: { pincode: "222222", zone: "TEST-ZONE" }, warehouseSnapshot: { id: warehouseId, name: "Test hub", address: "Registered test address", pincode: "111111", contact: "Test contact", phone: "9000000001", registrationStatus: "REGISTERED" }, packageRows: [{ boxes: 1, length: 10, width: 10, height: 10, weight: 500, unit: "cm", weightUnit: "gm" }], pricingSnapshot: { status: "TEST", card: { id: "card-test", scope: "WALK_IN_STANDARD", version: 1, currency: "INR" }, rateCardConfiguration: { zoneRates: [{ zone: "TEST-ZONE", modes: [{ mode: "SURFACE", weightSlabs: [{ minWeight: 0, maxWeight: 5, baseRate: "19" }] }, { mode: "EXPRESS", weightSlabs: [{ minWeight: 0, maxWeight: 5, baseRate: "29" }] }] }], surcharges: [], gstRules: [] }, customerSelling: { SURFACE: { status: "TEST", sellingPrice: 19, currency: "INR" }, EXPRESS: { status: "TEST", sellingPrice: 29, currency: "INR" } } } } };
  row.draftData.pricingSnapshot.card.name = "TEST Dummy Walk-in Standard";
  row.draftData.pricingSnapshot.inputs = { zone: "TEST-ZONE", chargeableWeight: 1, paymentType: "PREPAID", codAmount: 0 };
  row.draftData.pricingSnapshot.calculatedAt = new Date().toISOString();
  const customer = { _id: "dddddddddddddddddddddddd", owner: "owner-a" };
  row.draftData.formData.bookingCustomerId = customer._id;
  row.draftData.customerSnapshot.id = customer._id;
  const protectedDraft = includeProtectedDraft ? { _id: "cccccccccccccccccccccccc", owner: "owner-a", reference: "DRAFT-TEST-DRAFT-001", state: "draft", kind: "forward", updatedAt: new Date("2026-01-02T00:00:00.000Z"), draftData: { formData: { reference: "TEST-DRAFT-001" }, partnerQuoteBatches: [], bookingAttempt: null } } : null;
  const rows = [row, ...(protectedDraft ? [protectedDraft] : [])];
  const matches = (source, query) => Object.entries(query).every(([path, value]) => {
    const actual = path.split(".").reduce((target, key) => target?.[key], source);
    if (value && typeof value === "object" && "$in" in value) return value.$in.includes(actual);
    if (actual instanceof Date && value instanceof Date) return actual.getTime() === value.getTime();
    return actual === value;
  });
  const control = { failSavedWrites: false };
  const Shipment = {
    init: async () => {},
    findOne(query) { return { select() { return this; }, lean: async () => { const found = rows.find(item => matches(item, query)); return found ? structuredClone(found) : null; } }; },
    find(query) { return { lean: async () => structuredClone(rows.filter(item => matches(item, query))) }; },
    findOneAndUpdate(query, update) { return { lean: async () => {
      const target = rows.find(item => matches(item, query));
      if (!target) return null;
      if (control.failSavedWrites && update.$set.state === "saved") throw new Error("in-memory injected persistence failure");
      for (const [path, value] of Object.entries(update.$set)) {
        const keys = path.split(".");
        if (keys.length === 1) { target[keys[0]] = structuredClone(value); continue; }
        let nested = target;
        for (const key of keys.slice(0, -1)) nested = nested[key] ||= {};
        nested[keys.at(-1)] = structuredClone(value);
      }
      target.updatedAt = new Date();
      return structuredClone(target);
    } }; },
  };
  const Warehouse = { findOne: query => ({ lean: async () => {
    const matchesWarehouse = (item, filter) => Object.entries(filter).every(([key, value]) => {
      if (key === "$or") return value.some(clause => matchesWarehouse(item, clause));
      const actual = item[key];
      if (value && typeof value === "object" && "$in" in value) return value.$in.includes(actual ?? null);
      return String(actual ?? "") === String(value ?? "");
    });
    const found = [warehouse, foreignWarehouse].find(item => matchesWarehouse(item, query));
    return found ? structuredClone(found) : null;
  } }) };
  const Customer = { findOne: query => ({ lean: async () => matches(customer, query) ? customer : null }) };
  const partnerRegistry = injectedPartnerRegistry || createPartnerRegistry(adapters.map(adapter => ({
    ...adapter,
    async quote(context) { return { serviceable: true, mode: context.partnerInput.mode, ...await adapter.quote(context) }; },
  })));
  const app = express(); app.use(express.json()); app.use(makeRouter({ Shipment, Customer, Warehouse, partnerRegistry, getEnvironment: () => environment }));
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); if (original === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = original; });
  const request = async (path, owner = "owner-a", body) => {
    const token = owner && jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { request, row, protectedDraft, rows, Shipment, id, otherId, warehouseId, foreignWarehouseId, warehouse, customer, control };
}

async function quoteAndSelect(f, { owner = "owner-a" } = {}) {
  const quoted = await f.request(`/shipments/drafts/${f.id}/quotes`, owner, {});
  const quote = quoted.body.data?.quoteBatch?.quotes?.[0];
  if (quote) await f.request(`/shipments/drafts/${f.id}/quotes/${quote.id}/select`, owner, {});
  return quote;
}

test("two-mode comparison persists the selected Express rate on a Surface draft", async t => {
  const f = await fixture(t, [{ code: "TEST_COURIER",
    quote: async ({ partnerInput }) => ({ mode: partnerInput.mode, amount: partnerInput.mode === "EXPRESS" ? 60 : 40, currency: "INR" }),
  }]);
  const base = "/shipments/drafts/" + f.id + "/quotes";
  const result = await f.request(base, "owner-a", { compareModes: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.quoteBatch.quotes.map(quote => quote.mode), ["SURFACE", "EXPRESS"]);
  const express = result.body.data.quoteBatch.quotes[1];
  const selection = await f.request(base + "/" + express.id + "/select", "owner-a", {});
  assert.equal(selection.status, 200);
  assert.equal(selection.body.data.selectedMode, "Express");
  assert.equal(f.row.draftData.formData.mode, "Express");
  assert.equal(f.row.draftData.selectedPartnerQuote.id, express.id);
});

test("Delhivery reconciles a new attempt without resubmission and rejects an AWB already in use", async t => {
  let carrierReference;
  let providerResult = { status: "UNKNOWN" };
  let bookingCalls = 0;
  const f = await fixture(t, [{
    code: "DELHIVERY",
    quote: async () => ({ amount: 10, currency: "INR" }),
    checkServiceability: async () => true,
    book: async input => { bookingCalls++; carrierReference = input.providerReference; throw new Error("mock timeout"); },
    reconcile: async input => { assert.equal(input.providerReference, carrierReference); return providerResult; },
  }], { environment: { DELHIVERY_SHIPMENT_BOOKING_ENABLED: "true" } });
  const draft = f.row.draftData;
  draft.pricingSnapshot.status = "READY";
  draft.pricingSnapshot.card.name = "Approved fixture";
  for (const mode of Object.values(draft.pricingSnapshot.customerSelling)) mode.status = "READY";
  const path = "/shipments/drafts/" + f.id;
  draft.packageRows[0].boxes = 2;
  await quoteAndSelect(f);
  const unsupported = await f.request(path + "/book", "owner-a", {});
  assert.equal(unsupported.body.code, "DELHIVERY_MPS_UNAVAILABLE");
  assert.equal(bookingCalls, 0);
  draft.packageRows[0].boxes = 1;
  await quoteAndSelect(f);
  assert.equal((await f.request(path + "/book", "owner-a", {})).status, 502);
  assert.match(carrierReference, /^CMS-[a-f0-9]{32}$/);
  assert.equal(draft.bookingAttempt.providerReference, carrierReference);
  assert.deepEqual((await f.request(path + "/reconcile", "owner-a", {})).body.data,
    { status: "OUTCOME_UNCONFIRMED", retryAllowed: false });
  assert.equal((await f.request(path + "/book", "owner-a", {})).status, 404);
  providerResult = { status: "BOOKED", waybill: "1234567890" };
  f.rows.push({ _id: f.otherId, owner: "owner-b", state: "saved", waybill: providerResult.waybill });
  assert.equal((await f.request(path + "/reconcile", "owner-a", {})).status, 409);
  f.rows.pop();
  const recovered = await f.request(path + "/reconcile", "owner-a", {});
  assert.deepEqual(recovered.body.data, { status: "AWB_GENERATED", waybill: "1234567890", retryAllowed: false });
  assert.equal(f.row.reference, "DUMMY-REF-1");
  assert.equal(bookingCalls, 1);
});

test("draft quote request persists immutable provider snapshots and owner-scoped manual selection", async t => {
  let calls = 0; let received;
  const f = await fixture(t, [{ code: "MOCK_A", name: "Test Carrier", quote: async context => { calls++; received = context; return { serviceCode: "SURFACE", mode: "SURFACE", amount: 42, currency: "INR", estimateSnapshot: { source: "MOCK" } }; } }]);
  const path = `/shipments/drafts/${f.id}/quotes`;
  const response = await f.request(path, "owner-a", {});
  assert.equal(response.status, 200); assert.equal(response.body.data.quoteBatch.quotes[0].partnerCode, "MOCK_A");
  assert.equal(calls, 1); assert.equal(received.partnerInput.originPincode, "111111"); assert.equal(received.partnerInput.destinationPincode, "222222");
  assert.equal(received.customerPricingSnapshot.status, "TEST");
  const quote = response.body.data.quoteBatch.quotes[0];
  assert.equal((await f.request(path, "owner-b", {})).status, 404);
  assert.equal((await f.request(`/shipments/drafts/${f.id}/quotes/${quote.id}/select`, "owner-b", {})).status, 404);
  const selected = await f.request(`/shipments/drafts/${f.id}/quotes/${quote.id}/select`, "owner-a", {});
  assert.equal(selected.status, 200); assert.deepEqual(f.row.draftData.selectedPartnerQuote, quote);
  assert.equal(f.row.draftData.partnerQuoteBatches[0].quotes[0].estimateSnapshot.source, "MOCK");
});

test("unconfigured adapters return explicit configuration status without persisting or calling carriers", async t => {
  const f = await fixture(t, []);
  const result = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", {});
  assert.equal(result.status, 200); assert.equal(result.body.data.status, "CONFIGURATION_REQUIRED");
  assert.equal(f.row.draftData.partnerQuoteBatches.length, 1);
  assert.equal(f.row.draftData.partnerQuoteBatches[0].status, "CONFIGURATION_REQUIRED");
});

test("live comparison uses the configured Delhivery cost API for Surface and Express while mock booking stays isolated", async t => {
  const environment = {
    NODE_ENV: "test", APP_DEPLOYMENT_MODE: "uat", MOCK_COURIER_ADAPTER_ENABLED: "true",
    DELHIVERY_SHIPPING_COST_ENABLED: "true",
    DELHIVERY_BASE_URL: "https://carrier.example.test", DELHIVERY_API_TOKEN: "test-token",
  };
  const calls = [];
  const carrier = {
    get: async (path, options) => {
      calls.push({ path, params: options.params });
      return { data: [{ total_amount: options.params.md === "S" ? "71.25" : "124.50" }] };
    },
    post: async () => { throw new Error("Quotation flow must not make carrier mutations"); },
  };
  const partnerRegistry = createShipmentPartnerRegistry({
    carrier,
    mongooseInstance: { connection: { readyState: 1, name: "courier_testing" } },
    getEnvironment: () => environment,
  });
  const f = await fixture(t, [], { environment, injectedPartnerRegistry: partnerRegistry });
  assert.equal(partnerRegistry.quotations("live").get("DELHIVERY")?.code, "DELHIVERY");
  assert.equal(partnerRegistry.get("DELHIVERY"), null, "mock booking must not expose the live booking adapter");
  assert.equal(partnerRegistry.get("MOCK_LOCAL")?.code, "MOCK_LOCAL");

  const live = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", { compareModes: true });
  assert.equal(live.status, 200);
  assert.equal(live.body.data.status, "QUOTED");
  assert.deepEqual(live.body.data.quoteBatch.quotes.map(quote => [quote.partnerCode, quote.mode, quote.amount]), [
    ["DELHIVERY", "SURFACE", 71.25], ["DELHIVERY", "EXPRESS", 124.5],
  ]);
  assert.deepEqual(calls.map(call => call.params.md).sort(), ["E", "S"]);
  assert.equal(f.row.draftData.pricingSnapshot.customerSelling.SURFACE.sellingPrice, 19);
  assert.equal(f.row.draftData.pricingSnapshot.customerSelling.EXPRESS.sellingPrice, 29);

  const callCount = calls.length;
  const sample = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", { compareModes: true, source: "sample" });
  assert.equal(sample.status, 200);
  assert.ok(sample.body.data.quoteBatch.quotes.every(quote => quote.partnerCode === "MOCK_LOCAL" && quote.provenance === "LOCAL_MOCK"));
  assert.equal(calls.length, callCount, "explicit sample comparison must not contact Delhivery");
});

test("live Delhivery quotation errors are reported per mode without sample fallback", async t => {
  const environment = { APP_DEPLOYMENT_MODE: "uat", DELHIVERY_SHIPPING_COST_ENABLED: "true", DELHIVERY_BASE_URL: "https://carrier.example.test", DELHIVERY_API_TOKEN: "test-token" };
  const calls = [];
  const carrier = {
    get: async (path, options) => {
      calls.push(options.params.md);
      throw Object.assign(new Error("private provider response"), { isAxiosError: true, response: { status: 403 } });
    },
    post: async () => { throw new Error("Quotation flow must not make carrier mutations"); },
  };
  const partnerRegistry = createShipmentPartnerRegistry({ carrier, getEnvironment: () => environment });
  const f = await fixture(t, [], { environment, injectedPartnerRegistry: partnerRegistry });
  const result = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", { compareModes: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "UNAVAILABLE");
  assert.deepEqual(result.body.data.quoteBatch.quotes, []);
  assert.deepEqual(result.body.data.quoteBatch.unavailable.map(item => item.reason), [
    "Delhivery cost lookup failed (carrier HTTP 403).", "Delhivery cost lookup failed (carrier HTTP 403).",
  ]);
  assert.deepEqual(calls.sort(), ["E", "S"]);
  assert.equal(JSON.stringify(result.body).includes("private provider response"), false);
  assert.equal(f.row.draftData.partnerQuoteBatches[0].source, "live");
});

test("live comparison is unavailable when cost estimation is explicitly disabled", async t => {
  const environment = {
    DELHIVERY_BASE_URL: "https://carrier.example.test", DELHIVERY_API_TOKEN: "test-token",
    DELHIVERY_SHIPPING_COST_ENABLED: "false",
  };
  let calls = 0;
  const partnerRegistry = createShipmentPartnerRegistry({
    carrier: { get: async () => { calls++; return { data: [{ total_amount: "10" }] }; }, post: async () => assert.fail("No mutations") },
    getEnvironment: () => environment,
  });
  const f = await fixture(t, [], { environment, injectedPartnerRegistry: partnerRegistry });
  const result = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", { compareModes: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "CONFIGURATION_REQUIRED");
  assert.equal(result.body.data.quoteBatch.quotes.length, 0);
  assert.equal(calls, 0);
});

test("quote selection rejects an ID that was not previously quoted for this draft", async t => {
  const f = await fixture(t, []);
  assert.equal((await f.request(`/shipments/drafts/${f.id}/quotes/unknown/select`, "owner-a", {})).status, 404);
  assert.equal((await f.request(`/shipments/drafts/${f.otherId}/quotes`, "owner-a", {})).status, 404);
});




test("booking requires an explicit adapter and valid manually selected quotation", async t => {
  const f = await fixture(t, []);
  assert.equal((await f.request("/shipments/drafts/" + f.id + "/book", "owner-a", {})).status, 409);
  assert.equal(f.row.state, "draft");
  assert.equal((await f.request("/shipments/drafts/" + f.id + "/booking-status", "owner-a")).status, 200);
});

test("booking rejects a draft whose customer no longer belongs to the authenticated owner", async t => {
  const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ amount: 10, currency: "INR" }), book: async () => assert.fail("Booking must not be sent") }]);
  await quoteAndSelect(f);
  f.customer.owner = "owner-b";
  const result = await f.request("/shipments/drafts/" + f.id + "/book", "owner-a", {});
  assert.equal(result.body.code, "BOOKING_CUSTOMER_INVALID");
  assert.equal(f.row.state, "draft");
});

test("Delhivery booking requires ready pricing, a server-side serviceability check and a current tariff", async t => {
  let amount = 10;
  let serviceable = false;
  let checks = 0;
  let bookings = 0;
  const f = await fixture(t, [{
    code: "DELHIVERY",
    quote: async () => ({ amount, currency: "INR", serviceable: null }),
    checkServiceability: async input => {
      checks++;
      assert.deepEqual(input, { pincode: "222222", paymentType: "Prepaid" });
      return serviceable;
    },
    book: async () => { bookings++; return { waybill: "MOCK-DELHIVERY-AWB" }; },
  }], { environment: { DELHIVERY_SHIPMENT_BOOKING_ENABLED: "true" } });
  const book = () => f.request("/shipments/drafts/" + f.id + "/book", "owner-a", {});
  await quoteAndSelect(f);
  assert.equal((await book()).body.code, "BOOKING_PRICING_CONFIGURATION_REQUIRED");
  assert.equal(checks, 0);
  const pricing = f.row.draftData.pricingSnapshot;
  pricing.status = "READY";
  pricing.card.name = "Approved fixture";
  for (const mode of Object.values(pricing.customerSelling)) mode.status = "READY";
  await quoteAndSelect(f);
  assert.equal((await book()).body.code, "QUOTE_NOT_SERVICEABLE");
  assert.equal(checks, 1);
  serviceable = true;
  amount = 12;
  assert.equal((await book()).body.code, "QUOTE_STALE");
  assert.equal(bookings, 0);
  assert.equal(f.row.state, "draft");
  await quoteAndSelect(f);
  assert.equal((await book()).status, 201);
  assert.equal(bookings, 1);
});

for (const registrationStatus of ["FAILED", "CREATING", "OUTCOME_UNCONFIRMED"]) test(`booking rejects a warehouse that changed to ${registrationStatus} before reservation`, async t => {
  let bookCalls = 0;
  const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ serviceCode: "SURFACE", mode: "SURFACE", amount: 10, currency: "INR" }), book: async () => { bookCalls++; return { waybill: "MUST-NOT-BOOK" }; } }]);
  await quoteAndSelect(f);
  f.warehouse.registrationStatus = registrationStatus;
  const response = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "WAREHOUSE_INVALID");
  assert.equal(f.row.state, "draft");
  assert.equal(bookCalls, 0);
});

test("booking rejects nonexistent and other-owner warehouse IDs before reservation", async t => {
  let bookCalls = 0;
  const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ serviceCode: "SURFACE", mode: "SURFACE", amount: 10, currency: "INR" }), book: async () => { bookCalls++; return { waybill: "MUST-NOT-BOOK" }; } }]);
  await quoteAndSelect(f);
  for (const warehouseId of ["bbbbbbbbbbbbbbbbbbbbbbbb", f.foreignWarehouseId]) {
    f.row.draftData.formData.warehouseId = warehouseId;
    const response = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
    assert.equal(response.status, 409);
    assert.ok(["WAREHOUSE_INVALID", "QUOTE_STALE"].includes(response.body.code));
    assert.equal(f.row.state, "draft");
  }
  assert.equal(bookCalls, 0);
});

test("booking rejects registered warehouse details changed after quote generation", async t => {
  let bookCalls = 0;
  const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ serviceCode: "SURFACE", mode: "SURFACE", amount: 10, currency: "INR" }), book: async () => { bookCalls++; return { waybill: "MUST-NOT-BOOK" }; } }]);
  await quoteAndSelect(f);
  f.warehouse.details.pin = "333333";
  const response = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "WAREHOUSE_CHANGED");
  assert.equal(f.row.state, "draft");
  assert.equal(bookCalls, 0);
});

test("mock adapter booking persists AWB with distinct customer price and partner quote snapshots", async t => {
  let bookCalls = 0;
  const f = await fixture(t, [{ code: "MOCK_A", name: "Test Carrier", quote: async () => ({ serviceCode: "SURFACE", mode: "SURFACE", amount: 42, currency: "INR" }), book: async ({ draftSnapshot, selectedQuote }) => { bookCalls++; assert.equal(draftSnapshot.pricingSnapshot.status, "TEST"); assert.equal(selectedQuote.partnerCode, "MOCK_A"); return { waybill: "MOCK-AWB-123", receipt: { success: true, waybill: "MOCK-AWB-123" } }; } }]);
  f.row.draftData.formData.reference = "DUMMY-BOOK-1";
  const quoteResult = await f.request("/shipments/drafts/" + f.id + "/quotes", "owner-a", {});
  const quote = quoteResult.body.data.quoteBatch.quotes[0];
  await f.request("/shipments/drafts/" + f.id + "/quotes/" + quote.id + "/select", "owner-a", {});
  const booked = await f.request("/shipments/drafts/" + f.id + "/book", "owner-a", {});
  assert.equal(booked.status, 201);
  assert.equal(booked.body.shipment.waybill, "MOCK-AWB-123");
  assert.equal(booked.body.shipment.customerSellingPriceSnapshot.status, "TEST");
  assert.equal(booked.body.shipment.customerSellingPriceSnapshot.customerSelling.SURFACE.sellingPrice, 19);
  assert.deepEqual(booked.body.shipment.customerSnapshot, f.row.draftData.customerSnapshot);
  assert.deepEqual(booked.body.shipment.rateCardSnapshot, f.row.draftData.rateCardSnapshot);
  assert.deepEqual(booked.body.shipment.rateCardConfigurationSnapshot, f.row.draftData.pricingSnapshot.rateCardConfiguration);
  assert.deepEqual(booked.body.shipment.partnerQuoteSnapshot, quote);
  assert.equal(booked.body.shipment.partnerQuoteSnapshot.amount, 42);
  assert.equal(booked.body.shipment.estimatedPartnerCostSnapshot.amount, 42);
  assert.notEqual(booked.body.shipment.customerSellingPriceSnapshot.customerSelling.SURFACE.sellingPrice, booked.body.shipment.partnerQuoteSnapshot.amount);
  assert.equal(booked.body.shipment.partnerCostSnapshot, null);
  assert.deepEqual(booked.body.shipment.customerSellingPriceSnapshot, f.row.draftData.pricingSnapshot);
  assert.equal(booked.body.shipment.warehouseSnapshot.pincode, "111111");
  assert.equal(f.row.state, "saved");
  assert.equal(bookCalls, 1);
  assert.equal((await f.request("/shipments/drafts/" + f.id + "/booking-status", "owner-a")).body.data.status, "AWB_GENERATED");
  assert.equal((await f.request("/shipments/drafts/" + f.id + "/book", "owner-a", {})).status, 404);
});


test("unconfirmed mocked booking remains reserved and is not retried automatically", async t => {
  let calls = 0;
  const f = await fixture(t, [{ code: "MOCK_A", name: "Test Carrier", quote: async () => ({ serviceCode: "SURFACE", mode: "SURFACE", amount: 42, currency: "INR" }), book: async () => { calls++; throw new Error("simulated timeout"); } }]);
  f.row.draftData.formData.reference = "DUMMY-UNCERTAIN-1";
  const quoted = await f.request("/shipments/drafts/" + f.id + "/quotes", "owner-a", {});
  const quote = quoted.body.data.quoteBatch.quotes[0];
  await f.request("/shipments/drafts/" + f.id + "/quotes/" + quote.id + "/select", "owner-a", {});
  const failed = await f.request("/shipments/drafts/" + f.id + "/book", "owner-a", {});
  assert.equal(failed.status, 502); assert.equal(failed.body.code, "BOOKING_OUTCOME_UNCONFIRMED");
  assert.equal(f.row.state, "creating"); assert.equal(calls, 1);
  assert.equal(f.row.draftData.bookingAttempt.status, "OUTCOME_UNCONFIRMED");
  assert.equal((await f.request("/shipments/drafts/" + f.id + "/booking-status")).body.data.status, "OUTCOME_UNCONFIRMED");
  assert.equal((await f.request("/shipments/drafts/" + f.id + "/book", "owner-a", {})).status, 404);
  assert.equal(calls, 1);
});

test("invalid preflight and stale quote suppress adapter booking calls", async t => {
  let calls = 0;
  const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ amount: 10, currency: "INR" }), book: async () => { calls++; return { waybill: "NEVER" }; } }]);
  const quoted = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", {});
  let quote = quoted.body.data.quoteBatch.quotes[0];
  await f.request(`/shipments/drafts/${f.id}/quotes/${quote.id}/select`, "owner-a", {});
  f.row.draftData.packageRows[0].weight = 0;
  const invalid = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
  assert.equal(invalid.status, 400); assert.equal(invalid.body.code, "BOOKING_PREFLIGHT_FAILED"); assert.equal(calls, 0);

  f.row.state = "draft"; f.row.draftData.packageRows[0].weight = 500;
  f.row.draftData.partnerQuoteBatches = []; f.row.draftData.selectedPartnerQuote = null;
  const fresh = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", {});
  quote = fresh.body.data.quoteBatch.quotes[0];
  await f.request(`/shipments/drafts/${f.id}/quotes/${quote.id}/select`, "owner-a", {});
  f.row.draftData.formData.pincode = "333333";
  const stale = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "QUOTE_STALE"); assert.equal(calls, 0);
});

test("configuration-required and unavailable customer pricing fail closed before adapter booking", async t => {
  for (const pricingStatus of ["CONFIGURATION_REQUIRED", "UNAVAILABLE"]) {
    let bookCalls = 0;
    const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ amount: 42, currency: "INR" }), book: async () => { bookCalls++; return { waybill: "MUST-NOT-BOOK" }; } }]);
    f.row.draftData.pricingSnapshot.status = pricingStatus;
    f.row.draftData.pricingSnapshot.blockers = ["Client pricing rule is unresolved."];
    f.row.draftData.pricingSnapshot.customerSelling.SURFACE.status = pricingStatus;
    await quoteAndSelect(f);
    const result = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "BOOKING_PRICING_CONFIGURATION_REQUIRED");
    assert.equal(result.body.details.pricingStatus, pricingStatus);
    assert.match(result.body.message, /Customer selling-price configuration/);
    assert.deepEqual(result.body.details.blockers, ["Client pricing rule is unresolved."]);
    assert.equal(f.row.state, "draft");
    assert.equal(f.row.draftData.bookingAttempt, undefined);
    assert.equal(bookCalls, 0);
  }
});

test("missing selling-price values and customer, rate-card, or pricing-configuration snapshots fail closed", async t => {
  const scenarios = [
    { label: "pricing snapshot", mutate: data => { data.pricingSnapshot = null; } },
    { label: "selling price", mutate: data => { data.pricingSnapshot.customerSelling.SURFACE.sellingPrice = null; } },
    { label: "customer snapshot", mutate: data => { data.customerSnapshot = null; } },
    { label: "rate-card snapshot", mutate: data => { data.rateCardSnapshot = null; } },
    { label: "rate-card configuration snapshot", mutate: data => { data.pricingSnapshot.rateCardConfiguration = null; } },
  ];
  for (const scenario of scenarios) {
    let bookCalls = 0;
    const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ amount: 42, currency: "INR" }), book: async () => { bookCalls++; return { waybill: "MUST-NOT-BOOK" }; } }]);
    scenario.mutate(f.row.draftData);
    await quoteAndSelect(f);
    const result = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
    assert.equal(result.status, 409, scenario.label);
    assert.ok(["BOOKING_SNAPSHOT_INCOMPLETE", "BOOKING_PRICING_CONFIGURATION_REQUIRED"].includes(result.body.code), scenario.label);
    assert.match(result.body.message, /snapshot|selling price|pricing/i, scenario.label);
    assert.equal(f.row.state, "draft", scenario.label);
    assert.equal(bookCalls, 0, scenario.label);
  }
});

test("booking rejects a selected quote altered after selection even when its ID remains current", async t => {
  let bookCalls = 0;
  const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ amount: 42, currency: "INR" }), book: async () => { bookCalls++; return { waybill: "MUST-NOT-BOOK" }; } }]);
  const quote = await quoteAndSelect(f);
  f.row.draftData.selectedPartnerQuote.amount = 999;
  const result = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "QUOTE_NOT_CURRENT");
  assert.equal(bookCalls, 0);
  assert.equal(f.row.state, "draft");
  assert.equal(quote.amount, 42);
});

test("booking rejects a quote batch fingerprinted for a different draft", async t => {
  let bookCalls = 0;
  const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ amount: 42, currency: "INR" }), book: async () => { bookCalls++; return { waybill: "MUST-NOT-BOOK" }; } }]);
  await quoteAndSelect(f);
  f.row.draftData.partnerQuoteBatches[0].inputFingerprint = createDraftInputFingerprint(f.row.draftData, "different-draft");
  const result = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "QUOTE_STALE");
  assert.equal(bookCalls, 0);
  assert.equal(f.row.state, "draft");
});

test("booking rejects an expired quote even when draft inputs remain unchanged", async t => {
  let bookCalls = 0;
  const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ amount: 42, currency: "INR" }), book: async () => { bookCalls++; return { waybill: "MUST-NOT-BOOK" }; } }]);
  const quote = await quoteAndSelect(f);
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  f.row.draftData.partnerQuoteBatches[0].quotes[0].expiresAt = expiredAt;
  f.row.draftData.selectedPartnerQuote.expiresAt = expiredAt;
  const result = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "QUOTE_EXPIRED");
  assert.equal(bookCalls, 0);
  assert.equal(f.row.state, "draft");
  assert.ok(quote);
});

test("definitive rejection can be safely retried after confirmation; ambiguous timeout stays locked", async t => {
  let calls = 0;
  const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ amount: 10, currency: "INR" }), book: async () => { calls++; const error = new Error("mock definitive rejection"); error.definitive = true; throw error; } }]);
  const quoteSet = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", {}); const quote = quoteSet.body.data.quoteBatch.quotes[0];
  await f.request(`/shipments/drafts/${f.id}/quotes/${quote.id}/select`, "owner-a", {});
  const response = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
  assert.equal(response.status, 422); assert.equal(response.body.code, "BOOKING_REJECTED");
  assert.equal(f.row.state, "draft"); assert.equal(f.row.draftData.bookingAttempt.status, "BOOKING_REJECTED");
  assert.equal((await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {})).status, 422);
  assert.equal(calls, 2);
});

test("all provider failures are persisted with unavailable outcomes", async t => {
  const f = await fixture(t, [
    { code: "MOCK_A", quote: async () => { throw new Error("test offline"); } },
    { code: "MOCK_B", quote: async () => { throw new Error("test unavailable"); } },
  ]);
  const result = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", {});
  assert.equal(result.body.data.status, "UNAVAILABLE");
  assert.equal(f.row.draftData.partnerQuoteBatches.length, 1);
  assert.deepEqual(f.row.draftData.partnerQuoteBatches[0].quotes, []);
  assert.equal(f.row.draftData.partnerQuoteBatches[0].unavailable.length, 2);
});

test("mocked reconciliation after reload resolves AWB without a second booking", async t => {
  let bookCalls = 0; let reconcileCalls = 0;
  const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ amount: 10, currency: "INR" }), book: async () => { bookCalls++; throw new Error("simulated network timeout"); }, reconcile: async () => { reconcileCalls++; return { status: "BOOKED", waybill: "MOCK-RECOVERED-AWB" }; } }]);
  const quoteSet = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", {}); const quote = quoteSet.body.data.quoteBatch.quotes[0];
  await f.request(`/shipments/drafts/${f.id}/quotes/${quote.id}/select`, "owner-a", {});
  await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
  assert.equal((await f.request(`/shipments/drafts/${f.id}/booking-status`)).body.data.status, "OUTCOME_UNCONFIRMED");
  const reconciled = await f.request(`/shipments/drafts/${f.id}/reconcile`, "owner-a", {});
  assert.equal(reconciled.status, 200); assert.equal(reconciled.body.data.waybill, "MOCK-RECOVERED-AWB");
  assert.equal(f.row.state, "saved"); assert.equal(f.row.waybill, "MOCK-RECOVERED-AWB");
  assert.equal(bookCalls, 1); assert.equal(reconcileCalls, 1);
});

test("confirmed booking without immediate AWB is saved in a distinct pending-AWB state", async t => {
  const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ amount: 10, currency: "INR" }), book: async () => ({ bookingStatus: "BOOKED_AWB_PENDING", receipt: { accepted: true } }) }]);
  const quoteSet = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", {}); const quote = quoteSet.body.data.quoteBatch.quotes[0];
  await f.request(`/shipments/drafts/${f.id}/quotes/${quote.id}/select`, "owner-a", {});
  const booked = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
  assert.equal(booked.status, 201); assert.equal(f.row.state, "saved"); assert.equal(f.row.record.bookingStatus, "BOOKED_AWB_PENDING");
  assert.equal((await f.request(`/shipments/drafts/${f.id}/booking-status`)).body.data.status, "BOOKED_AWB_PENDING");
});

test("local mock booking saves a no-AWB shipment, updates dashboard count, and preserves TEST-DRAFT-001", async t => {
  const environment = { NODE_ENV: "test", MOCK_COURIER_ADAPTER_ENABLED: "true" };
  const adapter = createMockCourierAdapter({ getEnvironment: () => environment, getDatabaseName: () => "courier_testing" });
  const f = await fixture(t, [adapter], { includeProtectedDraft: true });
  const protectedBefore = structuredClone(f.protectedDraft);
  const emptyModel = { find: () => ({ lean: async () => [] }) };
  const overview = () => getDashboardOverview({ Shipment: f.Shipment, PickupRequest: emptyModel, NdrCase: emptyModel, RtoRecord: emptyModel }, "owner-a");
  assert.equal((await overview()).metrics.totalShipments, 0);

  const quoteResponse = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", {});
  assert.equal(quoteResponse.status, 200);
  const quote = quoteResponse.body.data.quoteBatch.quotes[0];
  assert.equal(quote.partnerCode, "MOCK_LOCAL");
  assert.equal(quote.estimateSnapshot.source, "LOCAL_MOCK_ONLY");
  assert.equal(quote.estimateSnapshot.networkRequestMade, false);
  assert.equal(quote.estimateSnapshot.awbGenerated, false);
  assert.equal(quote.estimateSnapshot.testReference, createTestReference("QUOTE", f.id));
  assert.equal((await f.request(`/shipments/drafts/${f.id}/quotes/${quote.id}/select`, "owner-a", {})).status, 200);

  const booked = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
  assert.equal(booked.status, 201);
  assert.equal(f.row.state, "saved");
  assert.equal(f.row.waybill, undefined);
  assert.equal(booked.body.shipment.waybill, "");
  assert.equal(booked.body.shipment.bookingStatus, "BOOKED_AWB_PENDING");
  assert.equal(booked.body.shipment.partnerCode, "MOCK_LOCAL");
  assert.equal(booked.body.shipment.mockOnly, true);
  assert.equal(booked.body.shipment.awbGenerated, false);
  assert.equal(booked.body.shipment.mockTestReference, createTestReference("BOOKING", "DUMMY-REF-1"));
  assert.deepEqual(booked.body.shipment.customerSellingPriceSnapshot, f.row.draftData.pricingSnapshot);
  assert.equal((await f.request(`/shipments/drafts/${f.id}/booking-status`)).body.data.status, "BOOKED_AWB_PENDING");
  assert.equal((await overview()).metrics.totalShipments, 1);
  assert.deepEqual(f.protectedDraft, protectedBefore);
});

test("provider acceptance followed by persistence failure remains unconfirmed and reconcilable without rebooking", async t => {
  let bookCalls = 0;
  const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ amount: 15, currency: "INR" }), book: async () => { bookCalls++; return { waybill: "MOCK-DBFAIL-AWB" }; }, reconcile: async () => ({ status: "BOOKED", waybill: "MOCK-DBFAIL-AWB" }) }]);
  const quoteSet = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", {}); const quote = quoteSet.body.data.quoteBatch.quotes[0];
  await f.request(`/shipments/drafts/${f.id}/quotes/${quote.id}/select`, "owner-a", {});
  f.control.failSavedWrites = true;
  const failedSave = await f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {});
  assert.equal(failedSave.status, 503); assert.equal(failedSave.body.code, "BOOKING_SAVE_FAILED");
  assert.equal(f.row.state, "creating"); assert.equal(bookCalls, 1);
  f.control.failSavedWrites = false;
  const recovered = await f.request(`/shipments/drafts/${f.id}/reconcile`, "owner-a", {});
  assert.equal(recovered.body.data.waybill, "MOCK-DBFAIL-AWB");
  assert.equal(f.row.state, "saved"); assert.equal(bookCalls, 1);
  assert.equal(f.row.record.partnerQuoteSnapshot.partnerCode, "MOCK_A");
  assert.equal(f.row.record.estimatedPartnerCostSnapshot.source, "PARTNER_QUOTE");
  assert.equal(f.row.record.partnerCostSnapshot, null);
});

test("concurrent retries perform at most one provider booking", async t => {
  let calls = 0;
  const f = await fixture(t, [{ code: "MOCK_A", quote: async () => ({ amount: 15, currency: "INR" }), book: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return { waybill: "MOCK-CONCURRENT-AWB" }; } }]);
  const quoteSet = await f.request(`/shipments/drafts/${f.id}/quotes`, "owner-a", {}); const quote = quoteSet.body.data.quoteBatch.quotes[0];
  await f.request(`/shipments/drafts/${f.id}/quotes/${quote.id}/select`, "owner-a", {});
  const results = await Promise.all([
    f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {}),
    f.request(`/shipments/drafts/${f.id}/book`, "owner-a", {}),
  ]);
  assert.equal(calls, 1);
  assert.ok(results.some(result => result.status === 201));
  assert.ok(results.some(result => result.status === 404 || result.status === 409));
});
