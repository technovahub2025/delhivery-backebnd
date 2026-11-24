const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PartnerConfigurationError, createPartnerRegistry, requestPartnerQuotes } = require("./courierQuotationService");

const fixedNow = () => new Date("2026-01-02T03:04:05.000Z");

test("partner registry requires unique adapter codes and quote capability", () => {
  assert.throws(() => createPartnerRegistry([{ code: "x" }]), PartnerConfigurationError);
  assert.throws(() => createPartnerRegistry([{ code: "x", quote() {} }, { code: "X", quote() {} }]), /Duplicate/);
  assert.equal(createPartnerRegistry().list().length, 0);
});

test("quotation service requests injected providers and returns immutable quote snapshots", async () => {
  const context = { draftId: "draft-1", customerPricingSnapshot: { status: "TEST", customerSelling: { SURFACE: { sellingPrice: 18 } } }, partnerInput: { oPin: "111111", dPin: "222222", weightKg: 1 } };
  const original = structuredClone(context);
  const registry = createPartnerRegistry([
    { code: "MOCK_A", name: "Mock Carrier A", quote: async input => { assert.deepEqual(input, context); return { serviceCode: "S", serviceName: "Surface", mode: "SURFACE", amount: "42.5", currency: "INR", estimateSnapshot: { raw: "mock" } }; } },
    { code: "MOCK_B", name: "Mock Carrier B", quote: async () => { throw new Error("test-only unavailable"); } },
  ]);
  const response = await requestPartnerQuotes(registry, context, { now: fixedNow });
  assert.deepEqual(context, original);
  assert.equal(response.status, "QUOTED");
  assert.equal(response.quotes.length, 1);
  assert.equal(response.quotes[0].partnerCode, "MOCK_A");
  assert.equal(response.quotes[0].amount, 42.5);
  assert.equal(response.quotes[0].currency, "INR");
  assert.equal(response.quotes[0].quotedAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(response.quotes[0].estimateSnapshot, { raw: "mock" });
  assert.equal(response.unavailable[0].partnerCode, "MOCK_B");
  assert.equal(Object.isFrozen(response.quotes[0]), true);
});

test("no configured provider is an explicit configuration state and bad quotes are rejected", async () => {
  assert.deepEqual(await requestPartnerQuotes(createPartnerRegistry(), {}), { status: "CONFIGURATION_REQUIRED", quotes: [], unavailable: [], message: "No courier quotation adapters are configured." });
  const registry = createPartnerRegistry([{ code: "MOCK", quote: async () => ({ amount: -1, currency: "INR" }) }]);
  const result = await requestPartnerQuotes(registry, {});
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.quotes.length, 0);
  assert.match(result.unavailable[0].reason, /invalid quotation amount/);
});

test("quotes retry transient read failures only when an adapter is configured", async () => {
  let calls = 0;
  let retryCalls = 0;
  const registry = createPartnerRegistry([{ code: "MOCK_RETRY", quote: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error("temporary"), { status: 503 }); return { amount: 12, currency: "INR" }; } }]);
  const result = await requestPartnerQuotes(registry, { draftId: "retry-test" }, { now: fixedNow, retry: async (operation, options) => { retryCalls += 1; return require("../utils/safeReadRetry").withSafeReadRetry(operation, { ...options, sleep: async () => {}, random: () => 0.5 }); } });
  assert.equal(result.status, "QUOTED");
  assert.equal(calls, 2);
  assert.equal(retryCalls, 1);

  retryCalls = 0;
  const disabled = await requestPartnerQuotes(createPartnerRegistry(), {}, { retry: async () => { retryCalls += 1; throw new Error("must not run"); } });
  assert.equal(disabled.status, "CONFIGURATION_REQUIRED");
  assert.equal(retryCalls, 0);
});