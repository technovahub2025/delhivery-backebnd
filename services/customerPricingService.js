const MODES = ["SURFACE", "EXPRESS"];

class PricingConfigurationError extends Error {}

function valueOf(value) {
  const number = Number(value?.toString?.() ?? value);
  return Number.isFinite(number) ? number : null;
}

function resolveCustomerCard(customer, cards) {
  if (!customer) return null;
  const card = cards.find(item => String(item._id) === String(customer.rateCardId));
  if (!card) return null;
  const compatible = customer.category === "CREDIT"
    ? card.scope === "CUSTOMER" && String(card.customerId) === String(customer._id)
    : customer.category === "WALK_IN" && card.scope === "WALK_IN_STANDARD" && card.customerId == null;
  return compatible ? card : null;
}

function matchingSlab(slabs, weight) {
  const rows = slabs || [];
  const matches = rows.filter(slab => weight > Number(slab.minWeight) && weight <= Number(slab.maxWeight));
  if (matches.length) return matches.length === 1 ? matches[0] : null;

  // An additional-weight rule on the unique terminal slab defines how that
  // slab continues above its maxWeight. Do not extend an interior or
  // ambiguous slab, and do not hide overlapping direct matches.
  const highest = Math.max(...rows.map(slab => Number(slab.maxWeight)).filter(Number.isFinite));
  const terminal = rows.filter(slab => Number(slab.maxWeight) === highest);
  if (terminal.length !== 1 || weight <= highest || terminal[0].additionalWeightCharge == null) return null;
  return terminal[0];
}

function asCents(amount) {
  if (amount == null || amount < 0) return null;
  const cents = Math.round(Number(`${amount}e2`));
  return Number.isSafeInteger(cents) ? cents : null;
}

function roundCents(amount) {
  const cents = Math.round(amount);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

function surchargeCents(rule, base, freight, cod) {
  const amount = valueOf(rule.value);
  if (amount == null || amount < 0) return null;
  const type = String(rule.calculationType || "").trim().toUpperCase();
  const basis = String(rule.basis || "").trim().toUpperCase();
  if (type === "FIXED" && basis === "SHIPMENT") return asCents(amount);
  const bases = { BASE_RATE: base, FREIGHT: freight, COD_AMOUNT: cod };
  if (type === "PERCENTAGE" && Object.hasOwn(bases, basis) && bases[basis] != null && (basis !== "COD_AMOUNT" || rule.kind === "COD")) {
    return roundCents(bases[basis] * amount / 100);
  }
  return null;
}

function snapshotValue(value) {
  if (value == null || typeof value !== "object") return value;
  if (value._bsontype === "Decimal128" || value._bsontype === "ObjectId") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(snapshotValue);
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_id" && key !== "owner" && key !== "__v").map(([key, child]) => [key, snapshotValue(child)]));
}

function calculateMode(card, { zone, weight, paymentType, codAmount }, mode) {
  const blockers = [];
  const zoneRows = (card.zoneRates || []).filter(item => String(item.zone).trim().toLowerCase() === String(zone || "").trim().toLowerCase());
  if (zoneRows.length !== 1) blockers.push(zoneRows.length ? "Destination zone is ambiguous." : "No matching destination zone is configured.");
  const modeRows = zoneRows.length === 1 ? zoneRows[0].modes.filter(item => item.mode === mode) : [];
  if (modeRows.length !== 1) blockers.push("No unique rate is configured for this shipping mode.");
  const slab = modeRows.length === 1 ? matchingSlab(modeRows[0].weightSlabs, weight) : null;
  if (!slab) blockers.push("Weight does not match exactly one configured slab.");

  const base = asCents(slab ? valueOf(slab.baseRate) : null);
  if (slab && base == null) blockers.push("The selected slab has an invalid base rate.");
  let additional = 0;
  if (slab?.additionalWeightCharge != null) {
    const included = slab.includedWeight;
    const increment = slab.additionalWeightIncrement;
    const perIncrement = asCents(valueOf(slab.additionalWeightCharge));
    if (!Number.isFinite(included) || included < 0 || included > slab.maxWeight || !Number.isFinite(increment) || increment <= 0 || perIncrement == null) {
      blockers.push("Additional-weight charges require an included weight and a positive increment.");
    } else {
      const steps = Math.max(0, (weight - included) / increment);
      additional = roundCents(Math.ceil(Number(steps.toPrecision(12))) * perIncrement);
      if (additional == null) blockers.push("Additional-weight charges exceed the supported amount.");
    }
  }
  const freight = base == null || additional == null ? null : roundCents(base + additional);

  let subtotal = freight;
  const surchargeLines = (card.surcharges || []).filter(rule => rule.kind !== "COD" || paymentType === "COD").map(rule => {
    const amount = surchargeCents(rule, base, freight, asCents(Number(codAmount)));
    if (amount == null) blockers.push(`Surcharge calculation semantics are incomplete for ${rule.label || rule.kind}.`);
    subtotal = subtotal == null || amount == null ? null : roundCents(subtotal + amount);
    return { kind: rule.kind, label: rule.label || rule.kind, value: valueOf(rule.value), calculationType: rule.calculationType || null, basis: rule.basis || null, amount: amount == null ? null : amount / 100 };
  });
  if (subtotal == null && !blockers.length) blockers.push("The shipment price exceeds the supported amount.");
  const gstRules = card.gstRules || [];
  const inclusive = gstRules[0]?.inclusive;
  const totalRate = gstRules.reduce((sum, rule) => sum + (valueOf(rule.rate) ?? 0), 0);
  const validGst = gstRules.every(rule => typeof rule.inclusive === "boolean" && rule.inclusive === inclusive && valueOf(rule.rate) >= 0 && rule.rate != null && valueOf(rule.rate) != null) && Number.isFinite(totalRate);
  if (!validGst) blockers.push("GST rules require valid rates and a consistent inclusive or exclusive treatment.");
  const taxableBasis = inclusive ? subtotal / (1 + totalRate / 100) : subtotal;
  let tax = 0;
  const gstLines = gstRules.map(rule => {
    const rate = valueOf(rule.rate);
    const amount = validGst && subtotal != null ? roundCents(taxableBasis * rate / 100) : null;
    if (amount != null) tax += amount;
    if (amount == null && validGst && subtotal != null) blockers.push("The GST amount exceeds the supported range.");
    return { name: rule.name || "GST", rate, inclusive: rule.inclusive, amount: amount == null ? null : amount / 100 };
  });
  const taxable = subtotal == null ? null : roundCents(inclusive ? subtotal - tax : subtotal);
  const total = subtotal == null ? null : roundCents(inclusive ? subtotal : subtotal + tax);
  if (subtotal != null && (taxable == null || total == null)) blockers.push("The taxed shipment price exceeds the supported amount.");

  const testCard = /^\s*(?:DEFAULT\s*\/\s*TEST|TEST\b|SAMPLE\b|DEMO\b)/i.test(card.name || "");
  const status = blockers.length ? "CONFIGURATION_REQUIRED" : testCard ? "TEST" : "READY";
  return {
    mode, status, currency: card.currency || null, zone, chargeableWeight: weight,
    baseRate: base == null ? null : base / 100, additionalWeightAmount: additional == null ? null : additional / 100, surchargeLines,
    gstLines, gstAmount: blockers.length || !gstRules.length ? null : tax / 100,
    taxableAmount: blockers.length || !gstRules.length ? null : taxable / 100,
    invoiceAmount: blockers.length || !gstRules.length ? null : total / 100,
    sellingPrice: blockers.length ? null : total / 100,
    blockers,
  };
}

function buildPricingSnapshot(card, input, { now = new Date() } = {}) {
  if (!card) return { status: "CONFIGURATION_REQUIRED", customerSelling: null, partnerCost: null, blockers: ["An applicable assigned rate card is required."] };
  const weight = Number(input.chargeableWeight);
  if (!Number.isFinite(weight) || weight <= 0) return { status: "CONFIGURATION_REQUIRED", card: { id: String(card._id), version: card.version }, customerSelling: null, partnerCost: null, blockers: ["A positive chargeable weight is required."] };
  const effectiveFrom = card.effectiveFrom && new Date(card.effectiveFrom);
  const effectiveTo = card.effectiveTo && new Date(card.effectiveTo);
  const date = new Date(now);
  const dateBlocker = (effectiveFrom && date < effectiveFrom) || (effectiveTo && date > effectiveTo) ? ["Rate card is outside its effective dates."] : [];
  const modes = Object.fromEntries(MODES.map(mode => [mode, calculateMode(card, { ...input, weight }, mode)]));
  if (dateBlocker.length) for (const quote of Object.values(modes)) { quote.status = "CONFIGURATION_REQUIRED"; quote.sellingPrice = null; quote.blockers.push(...dateBlocker); }
  const statuses = Object.values(modes).map(item => item.status);
  const status = statuses.every(status => status === "CONFIGURATION_REQUIRED") ? "CONFIGURATION_REQUIRED"
    : statuses.includes("CONFIGURATION_REQUIRED") ? "PARTIAL" : statuses.includes("TEST") ? "TEST" : "READY";
  return {
    status,
    card: { id: String(card._id), scope: card.scope, customerId: card.customerId ? String(card.customerId) : null, name: card.name || "", version: card.version, currency: card.currency || null },
    rateCardConfiguration: snapshotValue({ zoneRates: card.zoneRates || [], surcharges: card.surcharges || [], gstRules: card.gstRules || [], effectiveFrom: card.effectiveFrom || null, effectiveTo: card.effectiveTo || null }),
    inputs: { zone: input.zone, chargeableWeight: weight, paymentType: input.paymentType, codAmount: Number(input.codAmount || 0) },
    customerSelling: modes,
    ...((card.gstRules || []).length && { taxBasis: { gstTreatment: "SNAPSHOT" } }),
    blockers: [...new Set(Object.values(modes).flatMap(item => item.blockers))],
    partnerCost: null,
    calculatedAt: date.toISOString(),
  };
}

module.exports = { PricingConfigurationError, resolveCustomerCard, buildPricingSnapshot };
