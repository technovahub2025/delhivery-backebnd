const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveCustomerCard, buildPricingSnapshot } = require("./customerPricingService");

const customer = { _id: "customer-1", category: "CREDIT", rateCardId: "card-1" };
function card(overrides = {}) {
  return {
    _id: "card-1", name: "DEFAULT/TEST Dummy rate", scope: "CUSTOMER", customerId: "customer-1", version: 3, currency: "INR",
    zoneRates: [{ zone: "Z1", modes: [
      { mode: "SURFACE", weightSlabs: [{ minWeight: 0, maxWeight: 5, baseRate: "100" }] },
      { mode: "EXPRESS", weightSlabs: [{ minWeight: 0, maxWeight: 5, baseRate: "150" }] },
    ] }], surcharges: [], gstRules: [], ...overrides,
  };
}

test("resolves only owner-loaded compatible CREDIT and WALK_IN cards", () => {
  const creditCard = card();
  assert.equal(resolveCustomerCard(customer, [creditCard]), creditCard);
  assert.equal(resolveCustomerCard(customer, [{ ...creditCard, scope: "WALK_IN_STANDARD", customerId: null }]), null);
  assert.equal(resolveCustomerCard({ ...customer, category: "WALK_IN" }, [{ ...creditCard, scope: "WALK_IN_STANDARD", customerId: null }]).scope, "WALK_IN_STANDARD");
  assert.equal(resolveCustomerCard({ ...customer, category: "WALK_IN" }, [creditCard]), null);
});

test("selects configured zone/slab and reports both mode prices separately as TEST", () => {
  const result = buildPricingSnapshot(card(), { zone: "Z1", chargeableWeight: 2, paymentType: "PREPAID", codAmount: 0 });
  assert.equal(result.status, "TEST");
  assert.equal(result.card.version, 3);
  assert.equal(result.customerSelling.SURFACE.sellingPrice, 100);
  assert.equal(result.customerSelling.EXPRESS.sellingPrice, 150);
  assert.equal(result.rateCardConfiguration.zoneRates[0].modes[0].weightSlabs[0].baseRate, "100");
  assert.equal(result.partnerCost, null);
});

test("uses upper-inclusive boundaries and isolates ambiguous prices to the affected mode", () => {
  const ambiguous = card({ zoneRates: [{ zone: "Z1", modes: [{ mode: "SURFACE", weightSlabs: [{ minWeight: 0, maxWeight: 2, baseRate: "100" }, { minWeight: 2, maxWeight: 5, baseRate: "120" }, { minWeight: 3, maxWeight: 4, baseRate: "110" }] }, { mode: "EXPRESS", weightSlabs: [{ minWeight: 0, maxWeight: 5, baseRate: "150" }] }] }] });
  assert.equal(buildPricingSnapshot(ambiguous, { zone: "Z1", chargeableWeight: 2, paymentType: "PREPAID" }).customerSelling.SURFACE.sellingPrice, 100);
  assert.equal(buildPricingSnapshot(ambiguous, { zone: "Z1", chargeableWeight: 4, paymentType: "PREPAID" }).status, "PARTIAL");
  const unsupported = card({ surcharges: [{ kind: "FUEL", value: "5", calculationType: "PERCENTAGE", basis: "UNCONFIRMED" }] });
  assert.equal(buildPricingSnapshot(unsupported, { zone: "Z1", chargeableWeight: 1, paymentType: "PREPAID" }).status, "CONFIGURATION_REQUIRED");
});

test("calculates explicitly configured additional weight, surcharges and GST and snapshots them", () => {
  const configured = card({
    name: "Approved sample", surcharges: [
      { kind: "FUEL", value: "5", calculationType: "PERCENTAGE", basis: "BASE_RATE" },
      { kind: "COD", value: "20", calculationType: "FIXED", basis: "SHIPMENT" },
    ], gstRules: [{ name: "GST", rate: "18", inclusive: false }],
  });
  Object.assign(configured.zoneRates[0].modes[0].weightSlabs[0], { includedWeight: 1, additionalWeightIncrement: 0.5, additionalWeightCharge: "10" });
  const result = buildPricingSnapshot(configured, { zone: "Z1", chargeableWeight: 1.6, paymentType: "COD", codAmount: 200 });
  assert.equal(result.status, "READY");
  const price = result.customerSelling.SURFACE;
  assert.equal(price.additionalWeightAmount, 20);
  assert.deepEqual(price.surchargeLines.map(line => line.amount), [5, 20]);
  assert.equal(price.taxableAmount, 145);
  assert.equal(price.gstAmount, 26.1);
  assert.equal(price.sellingPrice, 171.1);
  assert.equal(result.taxBasis.gstTreatment, "SNAPSHOT");
  assert.equal(buildPricingSnapshot(configured, { zone: "Z1", chargeableWeight: 1, paymentType: "PREPAID" }).customerSelling.SURFACE.surchargeLines.length, 1);
  assert.equal(result.partnerCost, null);
});

test("continues a uniquely configured terminal weight slab above maxWeight using its increment charge", () => {
  const mongoose = require("mongoose");
  const configured = card({
    name: "ABC Technologies demo card",
    zoneRates: [{ zone: "Tamil Nadu", modes: [
      { mode: "SURFACE", weightSlabs: [{ minWeight: 0, maxWeight: 0.5, baseRate: mongoose.Types.Decimal128.fromString("60"), includedWeight: 0.5, additionalWeightIncrement: 0.5, additionalWeightCharge: mongoose.Types.Decimal128.fromString("20") }] },
      { mode: "EXPRESS", weightSlabs: [{ minWeight: 0, maxWeight: 0.5, baseRate: mongoose.Types.Decimal128.fromString("90"), includedWeight: 0.5, additionalWeightIncrement: 0.5, additionalWeightCharge: mongoose.Types.Decimal128.fromString("30") }] },
    ] }],
    surcharges: [
      { kind: "FUEL", label: "Fuel surcharge", calculationType: "PERCENTAGE", basis: "BASE_RATE", value: mongoose.Types.Decimal128.fromString("5") },
      { kind: "COD", label: "COD charge", calculationType: "FIXED", basis: "SHIPMENT", value: mongoose.Types.Decimal128.fromString("40") },
    ],
    gstRules: [{ name: "GST", rate: mongoose.Types.Decimal128.fromString("18"), inclusive: false }],
  });
  const expectedPrepaid = {
    SURFACE: [[0.5, 74.34], [0.6, 97.94], [1, 97.94], [1.1, 121.54]],
    EXPRESS: [[0.5, 111.51], [0.6, 146.91], [1, 146.91], [1.1, 182.31]],
  };
  for (const [mode, cases] of Object.entries(expectedPrepaid)) {
    for (const [weight, amount] of cases) {
      const result = buildPricingSnapshot(configured, { zone: "Tamil Nadu", chargeableWeight: weight, paymentType: "PREPAID", codAmount: 0 });
      const quote = result.customerSelling[mode];
      assert.equal(quote.status, "READY", `${mode} at ${weight}kg: ${quote.blockers.join("; ")}`);
      assert.equal(quote.sellingPrice, amount, `${mode} at ${weight}kg`);
      assert.deepEqual(quote.surchargeLines.map(line => line.kind), ["FUEL"]);
    }
  }
  const codSurface = buildPricingSnapshot(configured, { zone: "Tamil Nadu", chargeableWeight: 0.5, paymentType: "COD", codAmount: 250 }).customerSelling.SURFACE;
  const codExpress = buildPricingSnapshot(configured, { zone: "Tamil Nadu", chargeableWeight: 1.1, paymentType: "COD", codAmount: 250 }).customerSelling.EXPRESS;
  assert.equal(codSurface.sellingPrice, 121.54);
  assert.equal(codExpress.sellingPrice, 229.51);
  assert.deepEqual(codSurface.surchargeLines.map(line => line.amount), [3, 40]);
  assert.equal(codSurface.gstAmount, 18.54);
});

test("does not extend ambiguous terminal slabs or treat an absent slab as an invalid base rate", () => {
  const overlap = card({ zoneRates: [{ zone: "Z1", modes: [
    { mode: "SURFACE", weightSlabs: [
      { minWeight: 0, maxWeight: 0.5, baseRate: "60", includedWeight: 0.5, additionalWeightIncrement: 0.5, additionalWeightCharge: "20" },
      { minWeight: 0.1, maxWeight: 0.5, baseRate: "70", includedWeight: 0.5, additionalWeightIncrement: 0.5, additionalWeightCharge: "25" },
    ] },
    { mode: "EXPRESS", weightSlabs: [{ minWeight: 0, maxWeight: 5, baseRate: "90" }] },
  ] }] });
  const result = buildPricingSnapshot(overlap, { zone: "Z1", chargeableWeight: 1, paymentType: "PREPAID" });
  assert.equal(result.customerSelling.SURFACE.status, "CONFIGURATION_REQUIRED");
  assert.ok(result.customerSelling.SURFACE.blockers.includes("Weight does not match exactly one configured slab."));
  assert.ok(!result.customerSelling.SURFACE.blockers.includes("The selected slab has an invalid base rate."));
});
