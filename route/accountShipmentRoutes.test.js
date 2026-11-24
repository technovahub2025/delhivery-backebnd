const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const makeRouter = require("../services/appShipmentRouter");
const { validateMappings } = require("../services/providerStatusMappings");
const { DELHIVERY_FEATURES } = require("../utils/delhiveryFeatureFlags");
const statusMappings = validateMappings({ MOCK: { shipment: { Delivered: "DELIVERED", "In Transit": "IN_TRANSIT" } } });

// In-memory repository only in tests; production uses the Mongoose model.
async function fixture(t, mappings = {}) {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "shipment-tests-only";
  const rows = [];
  const warehouseId = "eeeeeeeeeeeeeeeeeeeeeeee";
  const foreignWarehouseId = "ffffffffffffffffffffffff";
  const customerId = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const rateCardId = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const pricingInput = { customerId, zone: "Z1", chargeableWeight: 0.5 };
  const warehouse = { _id: warehouseId, owner: "user-a", name: "REGISTERED-HUB", registrationStatus: "REGISTERED", details: { address: "1 Registered Road", pin: "110001", phone: "9000000001" } };
  const foreignWarehouse = { _id: foreignWarehouseId, owner: "user-b", name: "FOREIGN-HUB", registrationStatus: "REGISTERED", details: { address: "Foreign Road", pin: "100001", phone: "9000000002" } };
  const flags = { calls: 0, dbDown: false, saveFail: false, reject: false, timeout: false, delhiveryEnabled: "true", warehouseStatus: "REGISTERED", providerData: null };
  const matches = (row, query) => Object.entries(query).every(([k, v]) => {
    if (k === "$or") return v.some(branch => matches(row, branch));
    if (v && typeof v === "object" && Object.hasOwn(v, "$in")) return v.$in.includes(row[k] ?? null);
    if (v && typeof v === "object" && Object.hasOwn(v, "$exists")) {
      return v.$exists === Object.hasOwn(row, k);
    }
    return row[k] === v;
  });
  const db = () => { if (flags.dbDown) throw new Error("database unavailable"); };
  const Shipment = {
    init: async () => db(),
    findOne: async (q) => { db(); return rows.find(r => matches(r, q)); },
    create: async (data) => { db(); const row = { ...data, _id: String(rows.length + 1), createdAt: new Date() }; rows.push(row); return row; },
    countDocuments: async (q) => { db(); return rows.filter(r => matches(r, q)).length; },
    find(q) {
      let skip = 0, limit = 100;
      return { sort() { return this; }, skip(n) { skip = n; return this; }, limit(n) { limit = n; return this; },
        async lean() { db(); return rows.filter(r => matches(r, q)).slice(skip, skip + limit); } };
    },
    updateOne: async (q, update) => {
      if (flags.saveFail) throw new Error("save failed");
      const row = rows.find(r => matches(r, q));
      if (!row) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      for (const [k, v] of Object.entries(update.$set)) {
        if (k.startsWith("record.")) row.record[k.slice(7)] = v;
        else row[k] = v;
      }
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
    deleteOne: async (q) => { const index = rows.findIndex(r => matches(r, q)); if (index >= 0) rows.splice(index, 1); },
  };
  const carrier = { get: async path => path.includes("invoice/charges") ? { data: [{ total_amount: "45.50" }] } :
    { data: { delivery_codes: flags.unserviceable ? [] : [{ postal_code: { pre_paid: "Y", cod: "Y" } }] } }, post: async (url, data) => {
    flags.calls++;
    flags.providerData = data;
    if (flags.timeout) throw new Error("timeout");
    if (flags.response) return { data: flags.response };
    if (flags.reject) return { data: { success: false, packages: [{ status: "Fail" }] } };
    return { data: url.includes("create") ? { success: true, packages: [{ waybill: "TEST-WAYBILL", status: "Success" }] } : { status: true } };
  } };
  const Warehouse = { findOne: query => ({ lean: async () => {
    db();
    const found = [warehouse, foreignWarehouse].find(item => matches(item, query) && (item !== warehouse || !item.registrationStatus || item.registrationStatus === flags.warehouseStatus));
    return found ? { ...found, registrationStatus: found === warehouse ? flags.warehouseStatus : found.registrationStatus } : null;
  } }) };
  const Customer = { findOne: query => ({ lean: async () => query.owner === "user-a" && query._id === customerId
    ? { _id: customerId, owner: "user-a", category: "CREDIT", displayName: "Test Client", rateCardId } : null }) };
  const RateCard = { findOne: query => ({ lean: async () => query.owner === "user-a" && query._id === rateCardId
    ? { _id: rateCardId, scope: "CUSTOMER", customerId, version: 2, currency: "INR", name: "Account tariff",
      zoneRates: [{ zone: "Z1", modes: [{ mode: "SURFACE", weightSlabs: [{ minWeight: 0, maxWeight: 5, baseRate: "100" }] }] }] } : null }) };
  const app = express(); app.use(express.json()); app.use(makeRouter({ Shipment, Customer, RateCard, Warehouse, carrier, statusMappings: mappings, getEnvironment: () => Object.fromEntries(Object.values(DELHIVERY_FEATURES).map(name => [name, flags.delhiveryEnabled])) }));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  });
  const request = async (path, owner = "user-a", body) => {
    const token = owner && jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const create = (owner = "user-a", warehouseRef = warehouseId, price = pricingInput, reference = "ORDER-1") => request("/shipments", owner, { pricingInput: price, shipments: [{ order: reference, name: "Recipient", pin: "110001", weight: "500", total_amount: "100", payment_mode: "Prepaid", shipping_mode: "Surface" }], pickup_location: { warehouseId: warehouseRef, name: "CLIENT-SUPPLIED-SPOOF" } });
  return { request, create, pricingInput, flags, rows, warehouse, warehouseId, foreignWarehouseId };
}

test("legacy booking requires a valid owned pricing context and replays without repricing", async t => {
  const f = await fixture(t);
  assert.equal((await f.create("user-a", f.warehouseId, null)).body.code, "BOOKING_PRICING_INPUT_INVALID");
  assert.equal((await f.create("user-a", f.warehouseId, { ...f.pricingInput, chargeableWeight: 0.49 })).body.code, "BOOKING_PRICING_INPUT_INVALID");
  assert.equal((await f.create("user-a", f.warehouseId, { ...f.pricingInput, customerId: "cccccccccccccccccccccccc" })).status, 404);
  assert.equal(f.flags.calls, 0);
  const created = await f.create();
  assert.equal(created.status, 201);
  assert.equal(created.body.shipment.customerSellingPriceSnapshot.customerSelling.SURFACE.sellingPrice, 100);
  assert.equal(created.body.shipment.rateCardSnapshot.version, 2);
  assert.equal(created.body.shipment.warehouseSnapshot.id, f.warehouseId);
  assert.equal(created.body.shipment.estimatedPartnerCostSnapshot.amount, 45.5);
  assert.equal(created.body.shipment.estimatedPartnerCostSnapshot.source, "PARTNER_QUOTE");
  assert.equal(created.body.shipment.finalPartnerCostSnapshot, undefined);
  const replay = await f.create("user-a", f.warehouseId, null);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.shipment.rateCardSnapshot.version, 2);
  assert.equal(f.flags.calls, 1);
  assert.equal(JSON.parse(decodeURIComponent(f.flags.providerData.split("&data=")[1])).pricingInput, undefined);
});

test("legacy booking accepts an owner's saved legacy warehouse but rejects another owner's warehouse", async t => {
  const f = await fixture(t);
  delete f.warehouse.registrationStatus;
  f.warehouse.state = "saved";
  const own = await f.create();
  assert.equal(own.status, 201);
  assert.equal(own.body.shipment.warehouseSnapshot.registrationStatus, "REGISTERED");

  const otherOwner = await f.create("user-b", f.warehouseId);
  assert.equal(otherOwner.body.code, "WAREHOUSE_INVALID");
  const foreign = await f.create("user-a", f.foreignWarehouseId, f.pricingInput, "ORDER-2");
  assert.equal(foreign.body.code, "WAREHOUSE_INVALID");
});
test("requires authentication and validates pagination", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/shipments", null)).status, 401);
  for (const q of ["page=0", "limit=101", "page=1&page=2", "page=9007199254740991"]) assert.equal((await f.request(`/shipments?${q}`)).status, 400);
});
test("legacy direct booking is blocked when its feature flag is false", async t => {
  const f = await fixture(t); f.flags.delhiveryEnabled = "false";
  const response = await f.create();
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "DELHIVERY_FEATURE_DISABLED");
  assert.match(response.body.message, /shipment booking feature is disabled/);
  assert.equal(f.flags.calls, 0);
  assert.equal(f.rows.length, 0);
});
test("legacy direct booking is blocked when its feature flag is missing", async t => {
  const f = await fixture(t); f.flags.delhiveryEnabled = undefined;
  const response = await f.create();
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "DELHIVERY_FEATURE_DISABLED");
  assert.equal(f.flags.calls, 0);
  assert.equal(f.rows.length, 0);
});
test("legacy direct booking requires provider serviceability before reserving a shipment", async t => {
  const f = await fixture(t);
  f.flags.unserviceable = true;
  const result = await f.create();
  assert.equal(result.body.code, "QUOTE_NOT_SERVICEABLE");
  assert.equal(f.flags.calls, 0);
  assert.equal(f.rows.length, 0);
});
test("explicitly enabled legacy booking preserves provider behavior with a mocked carrier", async t => {
  const f = await fixture(t); f.flags.delhiveryEnabled = "true";
  const response = await f.create();
  assert.equal(response.status, 201);
  assert.equal(f.flags.calls, 1);
  assert.equal(response.body.shipment.id, "TEST-WAYBILL");
  const submitted = JSON.parse(decodeURIComponent(f.flags.providerData.split("data=")[1]));
  assert.deepEqual(submitted.pickup_location, { name: "REGISTERED-HUB" });
  assert.equal(response.body.shipment.warehouse, "REGISTERED-HUB");
});

for (const registrationStatus of ["FAILED", "CREATING", "OUTCOME_UNCONFIRMED"]) test(`legacy booking rejects warehouse registration status ${registrationStatus} without provider call`, async t => {
  const f = await fixture(t);
  f.flags.warehouseStatus = registrationStatus;
  const response = await f.create();
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "WAREHOUSE_INVALID");
  assert.equal(f.flags.calls, 0);
  assert.equal(f.rows.length, 0);
});

test("legacy booking rejects missing, nonexistent and another-owner warehouses before provider call", async t => {
  const f = await fixture(t);
  const missingId = await f.request("/shipments", "user-a", { shipments: [{ order: "ORDER-1" }], pickup_location: { name: "CLIENT-SUPPLIED" } });
  assert.equal(missingId.status, 400);
  assert.equal((await f.create("user-a", "ffffffffffffffffffffffff")).body.code, "WAREHOUSE_INVALID");
  assert.equal((await f.create("user-b")).body.code, "WAREHOUSE_INVALID");
  assert.equal((await f.create("user-a", f.foreignWarehouseId)).body.code, "WAREHOUSE_INVALID");
  assert.equal(f.flags.calls, 0);
  assert.equal(f.rows.length, 0);
});
test("creation persists normalized data, survives a new login and isolates owners", async t => {
  const f = await fixture(t);
  assert.equal((await f.create()).status, 201);
  const own = await f.request("/shipments?page=1&limit=1");
  assert.equal(own.body.data.total, 1);
  assert.equal(own.body.data.shipments[0].weight, 0.5);
  assert.equal(own.body.data.source, "app-created");
  assert.equal((await f.request("/shipments", "user-b")).body.data.total, 0);
  assert.equal((await f.request("/shipments?page=2&limit=1")).body.data.shipments.length, 0);
  assert.equal((await f.create()).status, 200);
  assert.equal(f.flags.calls, 1);
});
test("account shipment response exposes only its backend canonical status group", async t => {
  const f = await fixture(t, statusMappings);
  assert.equal((await f.create()).status, 201);
  f.rows[0].record.partnerCode = "MOCK";
  f.rows[0].trackingStatus = "Delivered";
  f.rows[0].trackingEvents = [{ providerCode: "MOCK", status: "In Transit" }];
  const row = (await f.request("/shipments")).body.data.shipments[0];
  assert.equal(row.dashboardStatus, "delivered");
  assert.equal(row.trackingEvents, undefined);
  f.rows[0].trackingStatus = "Unmapped carrier status";
  const unknown = (await f.request("/shipments")).body.data.shipments[0];
  assert.equal(unknown.dashboardStatus, "unknown");
});
test("database outage is not a genuine empty state and blocks carrier creation", async t => {
  const f = await fixture(t); f.flags.dbDown = true;
  assert.equal((await f.request("/shipments")).status, 503);
  assert.equal((await f.create()).status, 503);
  assert.equal(f.flags.calls, 0);
});
test("provider rejection never creates a saved shipment", async t => {
  const f = await fixture(t); f.flags.reject = true;
  assert.equal((await f.create()).status, 502);
  assert.equal((await f.request("/shipments")).body.data.total, 0);
});
test("uncertain carrier response prevents duplicate submission", async t => {
  const f = await fixture(t); f.flags.timeout = true;
  assert.equal((await f.create()).status, 502);
  assert.equal((await f.create()).status, 409);
  assert.equal(f.flags.calls, 1);
});

test("partial-save rejection retains the reservation and blocks duplicate carrier calls", async t => {
  const f = await fixture(t);
  f.flags.response = {
    success: false,
    rmk: "An internal Error has occurred, Please get in touch with client.support@delhivery.com",
    packages: [{ waybill: "", status: "Fail", err_code: "ER0005", remarks: [
      "Crashing while saving package due to exception suspicious order/consignee. Package might have been partially saved."
    ] }],
  };
  const first = await f.create();
  assert.equal(first.status, 502);
  assert.equal(first.body.data.packages[0].err_code, "ER0005");
  assert.equal(f.rows.length, 1);
  assert.equal((await f.create()).status, 409);
  assert.equal(f.flags.calls, 1);
  assert.equal((await f.request("/shipments")).body.data.total, 0);
});

test("insufficient prepaid balance is explained while partial-save protection is retained", async t => {
  const f = await fixture(t);
  f.flags.response = {
    success: false,
    upload_wbn: "UPL8766056862935565231",
    rmk: "An internal Error has occurred, Please get in touch with client.support@delhivery.com",
    packages: [{ waybill: "", status: "Fail", remarks: [
      "Crashing while saving package due to exception 'Prepaid client manifest charge API failed due to insufficient balance'. Package might have been partially saved."
    ] }],
  };
  const response = await f.create();
  assert.equal(response.status, 502);
  assert.equal(response.body.success, false);
  assert.match(response.body.message, /insufficient balance/);
  assert.match(response.body.message, /partially saved/);
  assert.deepEqual(response.body.data, f.flags.response);
  assert.equal((await f.create()).status, 409);
  assert.equal(f.flags.calls, 1);
  assert.equal((await f.request("/shipments")).body.data.total, 0);
});

test("explicit rejection without partial-save warnings allows a corrected submission", async t => {
  const f = await fixture(t); f.flags.reject = true;
  assert.equal((await f.create()).status, 502);
  f.flags.reject = false;
  assert.equal((await f.create()).status, 201);
  assert.equal(f.flags.calls, 2);
});

test("carrier remarks are included in the failure message and raw response is preserved", async t => {
  const f = await fixture(t);
  f.flags.response = {
    success: false,
    packages: [{ status: "Fail", remarks: ["Pickup location does not exist.", "Verify warehouse name."] }],
  };
  const response = await f.create();
  assert.equal(response.status, 502);
  assert.match(response.body.message, /Pickup location does not exist\. Verify warehouse name\./);
  assert.deepEqual(response.body.data, f.flags.response);
  assert.equal((await f.request("/shipments")).body.data.total, 0);
});

test("top-level carrier rejection reason is shown when package remarks are missing", async t => {
  const f = await fixture(t);
  f.flags.response = { success: false, rmk: "Invalid payment mode for this account.", packages: [] };
  const response = await f.create();
  assert.equal(response.status, 502);
  assert.match(response.body.message, /Invalid payment mode for this account\./);
});

test("non-serviceable pincode with a partial-save warning is explained and cannot be resubmitted", async t => {
  const f = await fixture(t);
  f.flags.response = {
    success: false,
    package_count: 1,
    upload_wbn: "UPL17552450625836827658",
    packages: [{
      waybill: "", refnum: "876543", payment: "Pre-paid", status: "Fail", serviceable: false,
      remarks: ["Crashing while saving package due to exception '605017 is non serviceable pincode'. Package might have been partially saved."],
    }],
    rmk: "An internal Error has occurred, Please get in touch with client.support@delhivery.com",
  };
  const response = await f.create();
  assert.equal(response.status, 502);
  assert.match(response.body.message, /605017 is non serviceable pincode/);
  assert.match(response.body.message, /do not submit it with a new reference/i);
  assert.deepEqual(response.body.data, f.flags.response);
  assert.equal((await f.create()).status, 409);
  assert.equal(f.flags.calls, 1);
  assert.equal((await f.request("/shipments")).body.data.total, 0);
});
test("post-carrier save failure reports the real waybill and prevents duplicate submission", async t => {
  const f = await fixture(t); f.flags.saveFail = true;
  const response = await f.create();
  assert.equal(response.body.code, "SHIPMENT_SAVE_FAILED");
  assert.equal(response.body.waybill, "TEST-WAYBILL");
  assert.equal((await f.create()).status, 409);
  assert.equal(f.flags.calls, 1);
});
test("updates and cancellations are owner-scoped and persist only after acceptance", async t => {
  const f = await fixture(t);
  assert.equal((await f.create()).status, 201);
  assert.equal((await f.request("/shipments/cancel", "user-b", { waybill: "TEST-WAYBILL" })).status, 404);
  f.flags.reject = true;
  assert.equal((await f.request("/shipments/cancel", "user-a", { waybill: "TEST-WAYBILL" })).status, 502);
  assert.equal(f.rows[0].record.status, "Pending pickup");
  f.flags.reject = false;
  await f.request("/shipments/update", "user-a", { waybill: "TEST-WAYBILL", city: "Delhi", pin: "110001" });
  await f.request("/shipments/cancel", "user-a", { waybill: "TEST-WAYBILL" });
  const row = (await f.request("/shipments")).body.data.shipments[0];
  assert.equal(row.status, "Cancelled"); assert.equal(row.destination, "Delhi");
});

test("shipment update, cancellation and e-waybill actions fail closed when Delhivery is disabled", async t => {
  const f = await fixture(t);
  assert.equal((await f.create()).status, 201);
  f.flags.calls = 0;
  for (const flag of ["false", undefined]) {
    f.flags.delhiveryEnabled = flag;
    for (const [path, body] of [
      ["/shipments/update", { waybill: "TEST-WAYBILL", city: "Delhi" }],
      ["/shipments/cancel", { waybill: "TEST-WAYBILL" }],
      ["/shipments/ewaybill", { waybill: "TEST-WAYBILL", ewbn: "EWB-1" }],
    ]) {
      const response = await f.request(path, "user-a", body);
      assert.equal(response.status, 503);
      assert.equal(response.body.code, "DELHIVERY_FEATURE_DISABLED");
    }
  }
  assert.equal(f.flags.calls, 0);
});
