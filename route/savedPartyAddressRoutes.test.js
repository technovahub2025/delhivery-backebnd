const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const SavedPartyAddress = require("../model/savedPartyAddress");
const { createSavedPartyAddressRoutes } = require("./savedPartyAddressRoutes");

const OWNER_A = "user-a";
const OWNER_B = "user-b";
const CUSTOMER_A = "64b000000000000000000001";
const CUSTOMER_B = "64b000000000000000000002";
const ADDRESS_A = "64b000000000000000000011";
const ADDRESS_B = "64b000000000000000000012";

function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected?.$in) return expected.$in.some(value => value == null ? row[key] == null : String(value) === String(row[key]));
    if (key === "$or") return expected.some(branch => Object.entries(branch).some(([field, regex]) => {
      const value = row[field];
      return Array.isArray(value) ? value.some(item => regex.test(String(item))) : regex.test(String(value ?? ""));
    }));
    return String(row[key]) === String(expected);
  });
}

function fakeModel() {
  return class FakeModel {
    static rows = [];
    static failure = false;
    static check() { if (this.failure) throw new Error("database unavailable"); }
    static async countDocuments(filter) { this.check(); return this.rows.filter(row => matches(row, filter)).length; }
    static find(filter) {
      let skip = 0; let limit = 100;
      return {
        sort() { return this; }, skip(value) { skip = value; return this; }, limit(value) { limit = value; return this; },
        lean: async () => { this.check(); return this.rows.filter(row => matches(row, filter)).slice(skip, skip + limit); },
      };
    }
    static findOne(filter) {
      const query = { select() { return this; }, lean: async () => { this.check(); return this.rows.find(row => matches(row, filter)) || null; } };
      return query;
    }
    static async create(data) {
      this.check();
      const now = new Date();
      const record = { ...data, _id: new mongoose.Types.ObjectId(), createdAt: now, updatedAt: now };
      this.rows.push(record); return record;
    }
    static async findOneAndUpdate(filter, update) {
      this.check();
      const record = this.rows.find(row => matches(row, filter));
      if (!record) return null;
      Object.assign(record, update.$set, { updatedAt: new Date() }); return record;
    }
  };
}

async function fixture(t) {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "saved-party-address-tests-only";
  const AddressModel = fakeModel();
  const CustomerModel = fakeModel();
  CustomerModel.rows.push(
    { _id: new mongoose.Types.ObjectId(CUSTOMER_A), owner: OWNER_A },
    { _id: new mongoose.Types.ObjectId(CUSTOMER_B), owner: OWNER_B }
  );
  AddressModel.rows.push(
    { _id: new mongoose.Types.ObjectId(ADDRESS_A), owner: OWNER_A, customerId: new mongoose.Types.ObjectId(CUSTOMER_A), partyType: "SHIPPER", contactName: "A contact", city: "Pune", updatedAt: new Date() },
    { _id: new mongoose.Types.ObjectId(ADDRESS_B), owner: OWNER_B, partyType: "PICKUP", contactName: "B contact", city: "Delhi", updatedAt: new Date() }
  );
  const app = express();
  app.use(express.json());
  app.use("/api/party-addresses", createSavedPartyAddressRoutes({ SavedPartyAddressModel: AddressModel, CustomerModel }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
  });
  async function request(path, { owner = OWNER_A, method = "GET", body, token = true } = {}) {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/party-addresses${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { request, AddressModel, CustomerModel };
}

test("saved party address routes require an authenticated session", async t => {
  const { request } = await fixture(t);
  assert.equal((await request("/", { token: false })).status, 401);
  assert.equal((await request("/", { token: false, method: "POST", body: { partyType: "PICKUP" } })).status, 401);
});

test("creates each allowed party type, optionally associated with an owned customer", async t => {
  const { request, AddressModel } = await fixture(t);
  for (const partyType of ["SHIPPER", "CONSIGNEE", "PICKUP"]) {
    const body = { partyType, contactName: `${partyType} contact`, ...(partyType === "SHIPPER" ? { customerId: CUSTOMER_A } : {}) };
    const response = await request("/", { method: "POST", body });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.partyAddress.partyType, partyType);
    assert.equal(response.body.data.partyAddress.owner, undefined);
  }
  assert.equal(AddressModel.rows.at(-3).owner, OWNER_A);
  assert.equal(AddressModel.rows.at(-3).customerId.toString(), CUSTOMER_A);
  assert.equal((await request("/", { method: "POST", body: { partyType: "PICKUP", customerId: CUSTOMER_B } })).status, 404);
});

test("lists owner-scoped addresses with customer, type, and search filters", async t => {
  const { request } = await fixture(t);
  const all = await request("/");
  assert.equal(all.status, 200); assert.equal(all.body.data.total, 1);
  assert.equal((await request(`/?customerId=${CUSTOMER_A}`)).body.data.total, 1);
  assert.equal((await request("/", { method: "POST", body: { partyType: "CONSIGNEE", contactName: "Shared consignee" } })).status, 201);
  assert.equal((await request(`/?customerId=${CUSTOMER_A}&includeUnassigned=true`)).body.data.total, 2);
  assert.equal((await request(`/?customerId=${CUSTOMER_A}`)).body.data.total, 1);
  assert.equal((await request(`/?customerId=${CUSTOMER_B}&includeUnassigned=true`)).status, 404);
  assert.equal((await request("/?includeUnassigned=true")).status, 400);
  assert.equal((await request("/?partyType=SHIPPER")).body.data.total, 1);
  assert.equal((await request("/?search=Pune")).body.data.total, 1);
  assert.equal((await request(`/?customerId=${CUSTOMER_B}`)).status, 404);
  assert.equal((await request("/?partyType=WAREHOUSE")).status, 400);
  assert.equal((await request("/?customerId=invalid")).status, 400);
  assert.equal((await request("/?unexpected=x")).status, 400);
});

test("retrieves and updates only owned records, including customer association changes", async t => {
  const { request } = await fixture(t);
  assert.equal((await request(`/${ADDRESS_A}`)).status, 200);
  assert.equal((await request(`/${ADDRESS_B}`)).status, 404);
  assert.equal((await request("/bad-id")).status, 400);
  const updated = await request(`/${ADDRESS_A}`, { method: "PATCH", body: { partyType: "CONSIGNEE", customerId: null, city: "Mumbai" } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.partyAddress.partyType, "CONSIGNEE");
  assert.equal(updated.body.data.partyAddress.city, "Mumbai");
  assert.equal((await request(`/${ADDRESS_A}`, { method: "PATCH", body: { customerId: CUSTOMER_B } })).status, 404);
  assert.equal((await request(`/${ADDRESS_B}`, { method: "PATCH", body: { city: "no access" } })).status, 404);
});

test("rejects malformed fields, ids, and contact/address values", async t => {
  const { request } = await fixture(t);
  for (const body of [{}, { partyType: "WAREHOUSE" }, { partyType: "PICKUP", owner: OWNER_B }, { partyType: "PICKUP", customerId: "invalid" }, { partyType: "SHIPPER", extra: true }, { partyType: "SHIPPER", phone: "123" }, { partyType: "SHIPPER", email: "not-email" }, { partyType: "SHIPPER", pincode: "123" }, { partyType: "SHIPPER", addressLines: [2] }]) {
    assert.equal((await request("/", { method: "POST", body })).status, 400);
  }
  assert.equal((await request(`/${ADDRESS_A}`, { method: "PATCH", body: {} })).status, 400);
  assert.equal((await request(`/${ADDRESS_A}`, { method: "PATCH", body: { random: true } })).status, 400);
});

test("reports persistence failures and validates the Mongoose schema", async t => {
  const { request, AddressModel } = await fixture(t);
  AddressModel.failure = true;
  const list = await request("/");
  assert.equal(list.status, 503);
  assert.equal(list.headers.get("cache-control"), "no-store");
  AddressModel.failure = false;
  const missing = new SavedPartyAddress({ owner: OWNER_A });
  await assert.rejects(missing.validate(), error => error.name === "ValidationError" && Boolean(error.errors.partyType));
  const valid = new SavedPartyAddress({ owner: OWNER_A, partyType: "PICKUP" });
  await assert.doesNotReject(valid.validate());
});
