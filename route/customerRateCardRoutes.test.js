const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const RateCard = require("../model/customerRateCard");
const { createCustomerRateCardRoutes } = require("./customerRateCardRoutes");

const OWNER_A = "user-a";
const OWNER_B = "user-b";
const CUSTOMER_A = "64b000000000000000000001";
const CUSTOMER_B = "64b000000000000000000002";
const CARD_A = "64b000000000000000000011";
const CARD_B = "64b000000000000000000012";

const standardBody = {
  scope: "CUSTOMER",
  customerId: CUSTOMER_A,
  name: "Contract pricing",
  currency: "INR",
  effectiveFrom: "2026-01-01",
  zoneRates: [{ zone: "Zone A", modes: [{ mode: "SURFACE", weightSlabs: [{ minWeight: 0, maxWeight: 5, baseRate: "125.50", additionalWeightCharge: "20" }] }, { mode: "EXPRESS", weightSlabs: [{ minWeight: 0, maxWeight: 5, baseRate: "180" }] }] }],
  surcharges: [{ kind: "FUEL", calculationType: "PERCENTAGE", basis: "UNCONFIRMED", value: "5.5" }, { kind: "COD", value: "25" }, { kind: "OTHER", label: "Handling", value: "8" }],
  gstRules: [{ name: "GST", rate: "18", inclusive: false }],
};

function pathValue(row, path) { return path.split(".").reduce((current, key) => current?.[key], row); }
function matches(row, filter) { return Object.entries(filter).every(([key, value]) => key === "$or"
    ? value.some(branch => Object.entries(branch).some(([path, expected]) => String(pathValue(row, path)) === String(expected)))
    : value instanceof RegExp ? value.test(String(pathValue(row, key) || "")) : String(pathValue(row, key)) === String(value)); }
function fakeModel() {
  return class FakeModel {
    static rows = [];
    static failure = false;
    static check() { if (this.failure) throw new Error("database unavailable"); }
    static async countDocuments(filter) { this.check(); return this.rows.filter(row => matches(row, filter)).length; }
    static find(filter) {
      let skip = 0; let limit = 100;
      return { sort() { return this; }, skip(value) { skip = value; return this; }, limit(value) { limit = value; return this; }, lean: async () => { this.check(); return this.rows.filter(row => matches(row, filter)).slice(skip, skip + limit); } };
    }
    static findOne(filter) { return { select() { return this; }, lean: async () => { this.check(); return this.rows.find(row => matches(row, filter)) || null; } }; }
    static async create(data) {
      this.check();
      const now = new Date();
      const row = { ...data, _id: new mongoose.Types.ObjectId(), createdAt: now, updatedAt: now };
      this.rows.push(row); return row;
    }
    static async findOneAndUpdate(filter, update) {
      this.check(); const row = this.rows.find(item => matches(item, filter)); if (!row) return null;
      Object.assign(row, update.$set, { updatedAt: new Date() }); return row;
    }
  };
}
async function fixture(t) {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "rate-card-route-tests-only";
  const RateCardModel = fakeModel(); const CustomerModel = fakeModel(); const ShipmentModel = fakeModel();
  CustomerModel.rows.push(
    { _id: new mongoose.Types.ObjectId(CUSTOMER_A), owner: OWNER_A, category: "CREDIT" },
    { _id: new mongoose.Types.ObjectId(CUSTOMER_B), owner: OWNER_B, category: "CREDIT" },
    { _id: new mongoose.Types.ObjectId("64b000000000000000000003"), owner: OWNER_A, category: "WALK_IN" }
  );
  RateCardModel.rows.push(
    { ...structuredClone(standardBody), _id: new mongoose.Types.ObjectId(CARD_A), owner: OWNER_A, version: 1, updatedAt: new Date() },
    { ...structuredClone(standardBody), _id: new mongoose.Types.ObjectId(CARD_B), owner: OWNER_B, version: 1, customerId: new mongoose.Types.ObjectId(CUSTOMER_B), updatedAt: new Date() }
  );
  const app = express(); app.use(express.json());
  app.use("/api/rate-cards", createCustomerRateCardRoutes({ RateCardModel, CustomerModel, ShipmentModel }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret; });
  async function request(path, { owner = OWNER_A, method = "GET", body, token = true } = {}) {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rate-cards${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { request, RateCardModel, CustomerModel, ShipmentModel };
}

test("rate card routes require authentication", async t => {
  const { request } = await fixture(t);
  assert.equal((await request("/", { token: false })).status, 401);
  assert.equal((await request("/", { token: false, method: "POST", body: standardBody })).status, 401);
});

test("creates CUSTOMER and WALK_IN_STANDARD cards with correctly scoped customer references", async t => {
  const { request, RateCardModel } = await fixture(t);
  const created = await request("/", { method: "POST", body: standardBody });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.rateCard.owner, undefined);
  assert.equal(created.body.data.rateCard.customerId, CUSTOMER_A);
  assert.equal(created.body.data.rateCard.version, 1);
  assert.equal(created.body.data.rateCard.zoneRates[0].modes[0].weightSlabs[0].baseRate, "125.50");
  assert.equal(RateCardModel.rows.at(-1).owner, OWNER_A);
  const walkIn = await request("/", { method: "POST", body: { ...standardBody, scope: "WALK_IN_STANDARD", customerId: undefined } });
  assert.equal(walkIn.status, 201);
  assert.equal(walkIn.body.data.rateCard.customerId, undefined);
  assert.equal((await request("/", { method: "POST", body: { ...standardBody, customerId: CUSTOMER_B } })).status, 404);
  assert.equal((await request("/", { method: "POST", body: { ...standardBody, customerId: "64b000000000000000000003" } })).status, 404);
  assert.equal((await request("/", { method: "POST", body: { ...standardBody, scope: "WALK_IN_STANDARD" } })).status, 400);
});

test("lists and retrieves only owner cards and validates filters and ObjectIds", async t => {
  const { request } = await fixture(t);
  const list = await request("/?scope=CUSTOMER&customerId=" + CUSTOMER_A);
  assert.equal(list.status, 200); assert.equal(list.body.data.total, 1);
  assert.equal((await request(`/${CARD_A}`)).status, 200);
  assert.equal((await request(`/${CARD_B}`)).status, 404);
  assert.equal((await request("/bad-id")).status, 400);
  assert.equal((await request("/?customerId=bad")).status, 400);
  assert.equal((await request("/?other=x")).status, 400);
  assert.equal((await request("/?customerId=64b000000000000000000002")).status, 404);
  assert.equal((await request("/?search=Contract")).body.data.total, 1);
  assert.equal((await request("/?search=" + "x".repeat(201))).status, 400);
});

test("pricing preview resolves only the authenticated customer's assigned compatible card", async t => {
  const { request, CustomerModel } = await fixture(t);
  const customer = CustomerModel.rows.find(row => String(row._id) === CUSTOMER_A);
  customer.rateCardId = new mongoose.Types.ObjectId(CARD_A);
  const body = { customerId: CUSTOMER_A, zone: "Zone A", chargeableWeight: 2, paymentType: "COD", codAmount: 200 };
  const result = await request("/pricing-preview", { method: "POST", body });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.pricing.card.id, CARD_A);
  assert.equal(result.body.data.pricing.customerSelling.SURFACE.baseRate, 125.5);
  assert.equal(result.body.data.pricing.partnerCost, null);
  assert.equal((await request("/pricing-preview", { method: "POST", body, token: false })).status, 401);
  assert.equal((await request("/pricing-preview", { method: "POST", body: { ...body, customerId: CUSTOMER_B } })).status, 404);
});

test("validates nested zones, modes, slabs, surcharges, GST, dates, and allowlists", async t => {
  const { request } = await fixture(t);
  const invalid = [
    { ...standardBody, zoneRates: [] },
    { ...standardBody, zoneRates: [{ zone: "", modes: [] }] },
    { ...standardBody, zoneRates: [{ zone: "Z", modes: [{ mode: "AIR", weightSlabs: [{ minWeight: 0, maxWeight: 1, baseRate: "1" }] }] }] },
    { ...standardBody, zoneRates: [{ zone: "Z", modes: [{ mode: "SURFACE", weightSlabs: [{ minWeight: 2, maxWeight: 1, baseRate: "1" }] }] }] },
    { ...standardBody, zoneRates: [{ zone: "Z", modes: [{ mode: "SURFACE", weightSlabs: [{ minWeight: 0, maxWeight: 1, baseRate: "-1" }] }] }] },
    { ...standardBody, zoneRates: [{ zone: "Z", modes: [{ mode: "SURFACE", weightSlabs: [{ minWeight: 0, maxWeight: 1, baseRate: "1", surprise: 1 }] }] }] },
    { ...standardBody, surcharges: [{ kind: "MYSTERY", value: "1" }] },
    { ...standardBody, gstRules: [{ rate: "not numeric", inclusive: "yes" }] },
    { ...standardBody, effectiveFrom: "2026-02-30" },
    { ...standardBody, effectiveFrom: "2026-02-01", effectiveTo: "2026-01-01" },
    { ...standardBody, unexpected: true },
  ];
  for (const body of invalid) assert.equal((await request("/", { method: "POST", body })).status, 400);
});

test("patches an unused card as a new version and rejects edits to shipment-used cards", async t => {
  const { request, RateCardModel, ShipmentModel } = await fixture(t);
  const patched = await request(`/${CARD_A}`, { method: "PATCH", body: { name: "Revised tariff" } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.rateCard.name, "Revised tariff");
  assert.equal(patched.body.data.rateCard.version, 2);
  assert.equal((await request(`/${CARD_B}`, { method: "PATCH", body: { name: "Cross owner" } })).status, 404);
  ShipmentModel.rows.push({ owner: OWNER_A, record: { pricingSnapshot: { rateCardId: CARD_A } } });
  assert.equal((await request(`/${CARD_A}`, { method: "PATCH", body: { name: "Historical overwrite" } })).status, 409);
  assert.equal(RateCardModel.rows[0].name, "Revised tariff");
  assert.equal((await request(`/${CARD_A}`, { method: "PATCH", body: { customerId: CUSTOMER_B } })).status, 404);
});

test("creates a new version without changing the existing card and protects owner scope", async t => {
  const { request, RateCardModel } = await fixture(t);
  const response = await request(`/${CARD_A}/versions`, { method: "POST", body: standardBody });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.rateCard.version, 2);
  assert.equal(RateCardModel.rows.find(row => String(row._id) === CARD_A).version, 1);
  assert.equal((await request(`/${CARD_B}/versions`, { method: "POST", body: { ...standardBody, customerId: CUSTOMER_B } })).status, 404);
  assert.equal((await request(`/${CARD_A}/versions`, { method: "POST", body: { ...standardBody, customerId: CUSTOMER_B } })).status, 400);
});

test("returns persistence errors and enforces model schema contracts", async t => {
  const { request, RateCardModel } = await fixture(t);
  RateCardModel.failure = true;
  const failure = await request("/");
  assert.equal(failure.status, 503);
  assert.equal(failure.body.success, false);
  assert.equal((await request("/", { method: "POST", body: standardBody })).status, 503);
  assert.equal((await request(`/${CARD_A}`, { method: "PATCH", body: { name: "unavailable" } })).status, 503);
  RateCardModel.failure = false;

  await assert.rejects(new RateCard({ owner: OWNER_A, scope: "CUSTOMER", customerId: CUSTOMER_A }).validate(), error => error.name === "ValidationError" && Boolean(error.errors.zoneRates));
  await assert.rejects(new RateCard({ owner: OWNER_A, scope: "WALK_IN_STANDARD", customerId: CUSTOMER_A, zoneRates: [{ zone: "Z", modes: [{ mode: "SURFACE", weightSlabs: [{ minWeight: 0, maxWeight: 1, baseRate: "1" }] }] }] }).validate(), error => error.name === "ValidationError" && Boolean(error.errors.customerId));
  await assert.doesNotReject(new RateCard({ owner: OWNER_A, scope: "WALK_IN_STANDARD", zoneRates: [{ zone: "Z", modes: [{ mode: "SURFACE", weightSlabs: [{ minWeight: 0, maxWeight: 1, baseRate: "1" }] }] }] }).validate());
});
