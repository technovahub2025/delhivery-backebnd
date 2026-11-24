const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Customer = require("../model/customer");
const { createCustomerRoutes } = require("./customerRoutes");

const OWNER_A = "user-a";
const OWNER_B = "user-b";
const ID_A = "64b000000000000000000001";
const ID_B = "64b000000000000000000002";

function pathValue(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") {
      return expected.some(branch => Object.entries(branch).every(([branchKey, pattern]) =>
        pattern.test(String(pathValue(row, branchKey) || ""))
      ));
    }
    return String(row[key]) === String(expected);
  });
}

function fakeCustomerModel() {
  return class FakeCustomerModel {
    static rows = [];
    static failure = false;
    static nextId = 10;

    static checkDatabase() {
      if (this.failure) throw new Error("database unavailable");
    }

    static async countDocuments(filter) {
      this.checkDatabase();
      return this.rows.filter(row => matches(row, filter)).length;
    }

    static find(filter) {
      let skip = 0;
      let limit = 100;
      return {
        sort() { return this; },
        skip(value) { skip = value; return this; },
        limit(value) { limit = value; return this; },
        lean: async () => {
          this.checkDatabase();
          return this.rows.filter(row => matches(row, filter)).slice(skip, skip + limit);
        },
      };
    }

    static findOne(filter) {
      return {
        lean: async () => {
          this.checkDatabase();
          return this.rows.find(row => matches(row, filter)) || null;
        },
      };
    }

    static async create(data) {
      this.checkDatabase();
      const now = new Date();
      const row = { ...data, _id: new mongoose.Types.ObjectId(), createdAt: now, updatedAt: now };
      this.rows.push(row);
      return row;
    }

    static async findOneAndUpdate(filter, update) {
      this.checkDatabase();
      const row = this.rows.find(item => matches(item, filter));
      if (!row) return null;
      Object.assign(row, update.$set, { updatedAt: new Date() });
      return row;
    }
  };
}

function fakeRateCardModel() {
  return class FakeRateCardModel {
    static rows = [];
    static findOne(filter) {
      const row = this.rows.find(item => String(item._id) === String(filter._id) && item.owner === filter.owner) || null;
      return { select() { return this; }, lean: async () => row };
    }
  };
}

async function fixture(t) {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "customer-route-tests-only";
  const Model = fakeCustomerModel();
  const RateCardModel = fakeRateCardModel();
  RateCardModel.rows.push(
    { _id: new mongoose.Types.ObjectId("64b0000000000000000000a1"), owner: OWNER_A, scope: "CUSTOMER", customerId: new mongoose.Types.ObjectId(ID_A) },
    { _id: new mongoose.Types.ObjectId("64b0000000000000000000a2"), owner: OWNER_A, scope: "WALK_IN_STANDARD" },
    { _id: new mongoose.Types.ObjectId("64b0000000000000000000b1"), owner: OWNER_B, scope: "CUSTOMER", customerId: new mongoose.Types.ObjectId(ID_B) }
  );
  Model.rows.push(
    { _id: new mongoose.Types.ObjectId(ID_A), owner: OWNER_A, category: "CREDIT", displayName: "Owned customer", creditLimit: 50, updatedAt: new Date() },
    { _id: new mongoose.Types.ObjectId(ID_B), owner: OWNER_B, category: "WALK_IN", displayName: "Other customer", updatedAt: new Date() }
  );
  const app = express();
  app.use(express.json());
  app.use("/api/customers", createCustomerRoutes({ CustomerModel: Model, RateCardModel }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  });

  async function request(path, { owner = OWNER_A, method = "GET", body, token = true } = {}) {
    const headers = { Accept: "application/json" };
    if (token) {
      headers.Authorization = `Bearer ${jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/customers${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }

  return { request, Model, RateCardModel };
}

test("customer routes require a verified session", async t => {
  const { request } = await fixture(t);
  assert.equal((await request("/", { token: false })).status, 401);
  assert.equal((await request("/", { token: false, method: "POST", body: { category: "WALK_IN" } })).status, 401);
});

test("creates a customer with optional rateCardId and derives owner from the JWT", async t => {
  const { request, Model } = await fixture(t);
  const response = await request("/", {
    method: "POST",
    body: {
      category: "WALK_IN",
      displayName: "  Walk-in contact  ",
      primaryContact: { name: " Contact ", email: " TEST@example.com " },
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.customer.displayName, "Walk-in contact");
  assert.equal(response.body.data.customer.primaryContact.email, "test@example.com");
  assert.equal(response.body.data.customer.rateCardId, undefined);
  assert.equal(Model.rows.at(-1).owner, OWNER_A);
  assert.equal(response.body.data.customer.owner, undefined);

  const forgedOwner = await request("/", { method: "POST", body: { category: "CREDIT", owner: OWNER_B } });
  assert.equal(forgedOwner.status, 400);
});

test("validates category, nested fields, and optional MongoDB references", async t => {
  const { request } = await fixture(t);
  assert.equal((await request("/", { method: "POST", body: {} })).status, 400);
  assert.equal((await request("/", { method: "POST", body: { category: "OTHER" } })).status, 400);
  assert.equal((await request("/", { method: "POST", body: { category: "CREDIT", arbitrary: true } })).status, 400);
  assert.equal((await request("/", { method: "POST", body: { category: "CREDIT", primaryContact: { secret: "x" } } })).status, 400);
  assert.equal((await request("/", { method: "POST", body: { category: "CREDIT", billingAddress: { pincode: "123" } } })).status, 400);
  assert.equal((await request("/", { method: "POST", body: { category: "CREDIT", rateCardId: "not-an-object-id" } })).status, 400);
  assert.equal((await request("/", { method: "POST", body: { category: "CREDIT", primaryContact: { email: "invalid" } } })).status, 400);
  assert.equal((await request("/", { method: "POST", body: { category: "CREDIT", primaryContact: { phone: "123" } } })).status, 400);
  assert.equal((await request("/", { method: "POST", body: { category: "CREDIT", creditLimit: -1 } })).status, 400);
  assert.equal((await request("/", { method: "POST", body: { category: "WALK_IN", creditLimit: 100 } })).status, 400);
  const validReference = await request(`/${ID_A}`, {
    method: "PATCH",
    body: { rateCardId: "64b0000000000000000000a1" },
  });
  assert.equal(validReference.status, 200);
  assert.equal((await request(`/${ID_A}`, { method: "PATCH", body: { rateCardId: "64b0000000000000000000b1" } })).status, 404);
  assert.equal((await request(`/${ID_A}`, { method: "PATCH", body: { rateCardId: "64b0000000000000000000a2" } })).status, 400);
});

test("validates card owner, category scope, and customer association for assignments", async t => {
  const { request } = await fixture(t);
  assert.equal((await request("/", { method: "POST", body: { category: "WALK_IN", rateCardId: "64b0000000000000000000a2" } })).status, 201);
  assert.equal((await request("/", { method: "POST", body: { category: "WALK_IN", rateCardId: "64b0000000000000000000a1" } })).status, 400);
  assert.equal((await request("/", { method: "POST", body: { category: "CREDIT", rateCardId: "64b0000000000000000000b1" } })).status, 404);
  assert.equal((await request("/", { method: "POST", body: { category: "CREDIT", rateCardId: "64b0000000000000000000a1" } })).status, 400);
});

test("lists only the authenticated owner's customers and validates filters", async t => {
  const { request } = await fixture(t);
  const own = await request("/?category=CREDIT&page=1&limit=1");
  assert.equal(own.status, 200);
  assert.equal(own.body.data.total, 1);
  assert.equal(own.body.data.customers[0].displayName, "Owned customer");
  assert.equal(own.body.data.page, 1);
  assert.equal((await request("/?category=UNKNOWN")).status, 400);
  assert.equal((await request("/?limit=101")).status, 400);
  assert.equal((await request("/?search=%5B%5D")).status, 200);
  assert.equal((await request("/?search=Owned")).body.data.total, 1);
});

test("customer API preserves shipment contact, billing, embedded shipper addresses and assigned rate-card references", async t => {
  const { request, Model } = await fixture(t);
  const rateCardId = new mongoose.Types.ObjectId("64b0000000000000000000a1");
  Object.assign(Model.rows[0], {
    companyName: "ABC Technologies Pvt Ltd",
    displayName: "ABC Technologies Pvt Ltd",
    primaryContact: { name: "Account Contact", phone: "9894525004", email: "account@example.test" },
    billingAddress: { addressLines: ["Billing Road"], city: "Chennai", state: "Tamil Nadu", pincode: "600001" },
    shippingAddresses: [{ addressLines: ["Saved Shipper Road"], city: "Chennai", state: "Tamil Nadu", pincode: "600002" }],
    gstin: "ABCDE1234F12345",
    rateCardId,
  });
  const response = await request("/?search=ABC");
  const listed = response.body.data.customers[0];
  assert.equal(response.status, 200);
  assert.equal(listed.id, ID_A);
  assert.equal(listed.companyName, "ABC Technologies Pvt Ltd");
  assert.deepEqual(listed.primaryContact, Model.rows[0].primaryContact);
  assert.deepEqual(listed.billingAddress, Model.rows[0].billingAddress);
  assert.deepEqual(listed.shippingAddresses, Model.rows[0].shippingAddresses);
  assert.equal(listed.gstin, "ABCDE1234F12345");
  assert.equal(listed.rateCardId, String(rateCardId));
  assert.equal(listed.owner, undefined);
  assert.equal((await request("/?search=ABC", { owner: OWNER_B })).body.data.total, 0);
});

test("GET and PATCH validate ObjectIds and conceal records owned by another user", async t => {
  const { request } = await fixture(t);
  assert.equal((await request(`/${ID_A}`)).status, 200);
  assert.equal((await request(`/${ID_B}`)).status, 404);
  assert.equal((await request("/bad-id")).status, 400);

  const updated = await request(`/${ID_A}`, { method: "PATCH", body: { displayName: "Updated" } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.customer.displayName, "Updated");
  assert.equal((await request(`/${ID_B}`, { method: "PATCH", body: { displayName: "No access" } })).status, 404);
  assert.equal((await request(`/${ID_A}`, { method: "PATCH", body: { owner: OWNER_B } })).status, 400);
  assert.equal((await request(`/${ID_A}`, { method: "PATCH", body: {} })).status, 400);
  assert.equal((await request(`/${ID_A}`, { method: "PATCH", body: { category: "WALK_IN" } })).status, 400);
  assert.equal((await request(`/${ID_A}`, { method: "PATCH", body: { category: "WALK_IN", creditLimit: null } })).status, 200);
  assert.equal((await request(`/${ID_A}`, { method: "PATCH", body: { rateCardId: null } })).status, 200);
});

test("persistence failures are service errors rather than empty successes", async t => {
  const { request, Model } = await fixture(t);
  Model.failure = true;
  const response = await request("/");
  assert.equal(response.status, 503);
  assert.equal(response.body.success, false);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("Customer schema requires owner and category without inventing customer identity fields", async () => {
  const missingRequiredFields = new Customer({ displayName: "No owner or category" });
  await assert.rejects(missingRequiredFields.validate(), error =>
    error.name === "ValidationError" && Boolean(error.errors.owner) && Boolean(error.errors.category)
  );

  const minimalCustomer = new Customer({ owner: OWNER_A, category: "WALK_IN" });
  await assert.doesNotReject(minimalCustomer.validate());

  const invalidCategory = new Customer({ owner: OWNER_A, category: "OTHER" });
  await assert.rejects(invalidCategory.validate(), error => error.name === "ValidationError");
});
