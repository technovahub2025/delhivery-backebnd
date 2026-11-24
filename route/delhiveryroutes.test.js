const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const carrier = require("../services/delhiveryService");
const Shipment = require("../model/appShipment");
const Warehouse = require("../model/delhiveryWarehouse");
const PickupRequest = require("../model/pickupRequest");
const Allocation = require("../model/waybillAllocation");
const { DELHIVERY_FEATURES } = require("../utils/delhiveryFeatureFlags");

const previousSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = "legacy-route-tests-only";
for (const name of Object.values(DELHIVERY_FEATURES)) process.env[name] = "true";
const router = require("./delhiveryroutes");

async function fixture(t) {
  process.env.JWT_SECRET = "legacy-route-tests-only";
  const originals = {
    get: carrier.get, post: carrier.post,
    shipmentFind: Shipment.find,
    warehouseCreate: Warehouse.create, warehouseFindOne: Warehouse.findOne,
    warehouseUpdateOne: Warehouse.updateOne, warehouseDeleteOne: Warehouse.deleteOne, warehouseFind: Warehouse.find,
    pickupCreate: PickupRequest.create, pickupInit: PickupRequest.init, pickupExists: PickupRequest.exists,
    pickupUpdate: PickupRequest.updateOne, pickupDelete: PickupRequest.deleteOne,
  };
  const shipments = [
    { owner: "owner-a", waybill: "1234567890", state: "saved" },
    { owner: "owner-b", waybill: "0987654321", state: "saved" },
  ];
  const warehouses = [];
  const pickups = [];
  const calls = [];
  const allocations = [];
  const allocationMethods = { init: Allocation.init, create: Allocation.create, findOne: Allocation.findOne, updateOne: Allocation.updateOne };
  Allocation.init = async () => {};
  Allocation.findOne = query => ({ lean: async () => allocations.find(row => Object.entries(query).every(([k, v]) => row[k] === v)) });
  Allocation.create = async data => {
    if (allocations.some(row => row.owner === data.owner && row.requestId === data.requestId)) throw Object.assign(new Error("duplicate key"), { code: 11000 });
    const row = { ...data, _id: String(allocations.length + 1) };
    allocations.push(row);
    return row;
  };
  Allocation.updateOne = async (query, update) => {
    const row = await Allocation.findOne(query).lean();
    if (!row) return { modifiedCount: 0 };
    if (update.$set.waybills?.some(number => allocations.some(item => item.waybills?.includes(number)))) {
      throw Object.assign(new Error("duplicate waybill"), { code: 11000 });
    }
    Object.assign(row, update.$set);
    return { modifiedCount: 1 };
  };
  let providerError = null;
  let providerResponse = { result: "mock" };
  let providerGetResponse = [{ total_amount: "12.50" }];
  let warehouseDeleteCalls = 0;
  let warehouseUpdateFailure = false;
  let id = 0;
  carrier.get = async (path, options) => {
    calls.push({ method: "get", path, options });
    if (providerError) throw providerError;
    if (path === "/api/kinko/v1/invoice/charges/.json") return { data: providerGetResponse };
    if (path === "/c/api/pin-codes/json/") return { data: providerGetResponse?.delivery_codes
      ? providerGetResponse : { delivery_codes: [{ postal_code: { pin: "110001", pre_paid: "N", cod: "N", pickup: "Y" } }] } };
    if (path === "/waybill/api/bulk/json/") return { data: providerGetResponse };
    if (path === "/api/p/packing_slip") return { data: providerGetResponse };
    return { data: { result: "mock" } };
  };
  carrier.post = async (path, data) => {
    calls.push({ method: "post", path, data });
    if (providerError) throw providerError;
    return { data: providerResponse };
  };
  Shipment.find = query => {
    if (query.waybill) return shipments.filter(row => row.owner === query.owner && row.state === query.state && query.waybill.$in.includes(row.waybill));
    return { select() { return this; }, async lean() {
      return shipments.filter(row => row.owner === query.owner && row.state === query.state &&
        query.$or.some(condition => Object.entries(condition).some(([key, filter]) => filter.$in.includes(row[key]))));
    } };
  };
  Warehouse.create = async data => {
    if (warehouses.some(row => row.nameKey === data.nameKey)) { const error = new Error("duplicate"); error.code = 11000; throw error; }
    const row = { ...data, _id: String(++id) }; warehouses.push(row); return row;
  };
  const matchesWarehouse = (row, query) => Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some(branch => matchesWarehouse(row, branch));
    if (value && typeof value === "object" && "$in" in value) return value.$in.includes(row[key] ?? null);
    return row[key] === value;
  });
  Warehouse.findOne = async query => warehouses.find(row => matchesWarehouse(row, query)) || null;
  Warehouse.updateOne = async (query, update) => {
    if (warehouseUpdateFailure) throw new Error("mock warehouse persistence failure");
    const row = warehouses.find(item => item._id === query._id && item.owner === query.owner && item.state === query.state);
    if (!row) return { matchedCount: 0 };
    Object.assign(row, update.$set);
    return { matchedCount: 1 };
  };
  Warehouse.find = query => ({
    sort() { return this; },
    limit() { return this; },
    lean: async () => warehouses.filter(row => row.owner === query.owner).sort((a, b) => a.nameKey.localeCompare(b.nameKey)),
  });
  Warehouse.deleteOne = async query => {
    warehouseDeleteCalls++;
    const index = warehouses.findIndex(row => row._id === query._id && row.owner === query.owner);
    if (index >= 0) warehouses.splice(index, 1);
  };
  PickupRequest.init = async () => {};
  PickupRequest.exists = async query => pickups.some(row =>
    row.owner === query.owner && row.warehouse === query.warehouse && row.pickupDate === query.pickupDate &&
    query.pickupTime.$in.includes(row.pickupTime) && row.packageCount === query.packageCount && row.workflow !== query.workflow.$ne);
  PickupRequest.create = async data => {
    if (pickups.some(row => row.owner === data.owner && row.carrierRequestKey === data.carrierRequestKey)) throw Object.assign(new Error("duplicate"), { code: 11000 });
    const row = { ...data, _id: String(++id) };
    pickups.push(row);
    return row;
  };
  const pickupIndex = query => pickups.findIndex(row => Object.entries(query).every(([key, value]) => row[key] === value));
  PickupRequest.updateOne = async (query, update) => {
    const index = pickupIndex(query);
    if (index < 0) return { matchedCount: 0 };
    Object.assign(pickups[index], update.$set);
    return { matchedCount: 1 };
  };
  PickupRequest.deleteOne = async query => {
    const index = pickupIndex(query);
    if (index >= 0) pickups.splice(index, 1);
  };

  const app = express(); app.use(express.json()); app.use("/api/delhivery", router);
  const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    carrier.get = originals.get; carrier.post = originals.post; Shipment.find = originals.shipmentFind;
    Warehouse.create = originals.warehouseCreate; Warehouse.findOne = originals.warehouseFindOne;
    Warehouse.updateOne = originals.warehouseUpdateOne; Warehouse.deleteOne = originals.warehouseDeleteOne;
    Warehouse.find = originals.warehouseFind;
    PickupRequest.create = originals.pickupCreate;
    PickupRequest.init = originals.pickupInit; PickupRequest.exists = originals.pickupExists;
    PickupRequest.updateOne = originals.pickupUpdate; PickupRequest.deleteOne = originals.pickupDelete;
    Object.assign(Allocation, allocationMethods);
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  });
  const request = async (path, { owner = "owner-a", method = "GET", body, auth = true } = {}) => {
    const token = auth ? jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" }) : null;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/delhivery${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, calls, shipments, warehouses, pickups, failProvider(error) { providerError = error; }, setProviderResponse(value) { providerResponse = value; }, setProviderGetResponse(value) { providerGetResponse = value; }, failWarehouseUpdates(value = true) { warehouseUpdateFailure = value; }, get warehouseDeleteCalls() { return warehouseDeleteCalls; } };
}

function enableDelhiveryForTest(t, value) {
  if (arguments.length < 2) value = "true";
  const previous = Object.values(DELHIVERY_FEATURES).map(name => [name, process.env[name]]);
  for (const name of Object.values(DELHIVERY_FEATURES)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, oldValue] of previous) {
      if (oldValue === undefined) delete process.env[name];
      else process.env[name] = oldValue;
    }
  });
}

const validWarehouse = {
  name: "Test Hub", registered_name: "Example Logistics", phone: "9876543210", email: "ops@example.com",
  address: "1 Main Road", pin: "110001", city: "Delhi", state: "Delhi", country: "India",
  return_address: "1 Main Road", return_pin: "110001", return_city: "Delhi", return_state: "Delhi", return_country: "India",
};

test("all nine legacy endpoints reject unauthenticated requests", async t => {
  const f = await fixture(t);
  const paths = [
    ["/pincode?pincode=110001"], ["/pincode/heavy?pincode=110001"],
    ["/expected-tat?origin_pin=110001&destination_pin=110002"], ["/waybills", { method: "POST", body: { count: 1 } }],
    ["/shipping-cost?md=S&ss=Delivered&d_pin=110001&o_pin=110002&cgm=1&pt=Pre-paid"],
    ["/shipping-label?waybill=1234567890"], ["/warehouses", { method: "POST", body: validWarehouse }],
    ["/warehouses/update", { method: "POST", body: validWarehouse }], ["/documents?waybill=1234567890"],
  ];
  for (const [path, options = {}] of paths) assert.equal((await f.request(path, { ...options, auth: false })).status, 401, path);
  assert.equal(f.calls.length, 0);
});

test("authenticated lookup and provider routes retain success envelopes", async t => {
  const f = await fixture(t);
  enableDelhiveryForTest(t);
  for (const path of [
    "/pincode?pincode=110001", "/pincode/heavy?pincode=110001",
    "/expected-tat?origin_pin=110001&destination_pin=110002&mot=S",
    "/shipping-cost?md=S&ss=Delivered&d_pin=110001&o_pin=110002&cgm=1&pt=Pre-paid",
  ]) {
    const response = await f.request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.body.success, true);
    if (path.startsWith("/shipping-cost")) assert.deepEqual(response.body.data, [{ total_amount: "12.50" }]);
    else if (path.startsWith("/pincode?")) assert.equal(response.body.serviceable, false);
    else assert.deepEqual(response.body.data, { result: "mock" });
  }
  assert.equal(f.calls.length, 4);
});

test("waybill allocation is POST-only and normalizes a confirmed batch without retrying malformed replies", async t => {
  enableDelhiveryForTest(t);
  const f = await fixture(t);
  assert.equal((await f.request("/waybills?count=1")).status, 405);
  assert.equal((await f.request("/waybills", { method: "POST", body: { count: 1.5 } })).status, 400);
  assert.equal(f.calls.length, 0);
  f.setProviderGetResponse("1234567890, 1234567891");
  const firstKey = "allocation-confirmed-1";
  const secondKey = "allocation-unconfirmed-1";
  const allocate = (requestId, count = 2) => f.request("/waybills", { method: "POST", body: { count, requestId } });
  const attempts = await Promise.all([allocate(firstKey), allocate(firstKey)]);
  const result = attempts.find(attempt => attempt.body.data?.state === "CONFIRMED");
  assert.deepEqual(result.body.data?.waybills, ["1234567890", "1234567891"]);
  assert.ok(attempts.every(attempt => attempt.status === 200));
  assert.equal((await allocate(firstKey, 3)).status, 409);
  assert.equal((await f.request("/waybills/allocations/" + firstKey, { owner: "owner-b" })).status, 404);
  assert.deepEqual((await f.request("/waybills/allocations/" + firstKey)).body.data.waybills, ["1234567890", "1234567891"]);
  assert.equal(f.calls[0].options.params.count, 2);
  f.setProviderGetResponse(["1234567890", "1234567890"]);
  const partial = await allocate(secondKey);
  assert.equal(partial.body.code, "WAYBILL_ALLOCATION_UNCONFIRMED");
  assert.equal((await allocate(secondKey)).body.data.state, "UNCONFIRMED");
  assert.equal(f.calls.length, 2);
  f.setProviderGetResponse(["1234567891", "1234567892"]);
  assert.equal((await allocate("allocation-overlap-1")).body.code, "WAYBILL_ALLOCATION_UNCONFIRMED");
  assert.equal((await f.request("/waybills/allocations/allocation-overlap-1")).body.data.waybills, undefined);
});

test("shipping label uses the documented single-waybill PDF request and handles missing labels", async t => {
  enableDelhiveryForTest(t);
  const f = await fixture(t);
  assert.equal((await f.request("/shipping-label?waybill=1234567890,0987654321")).status, 404);
  assert.equal(f.calls.length, 0);
  f.setProviderGetResponse({ packages: [], packages_found: 0 });
  const result = await f.request("/shipping-label?waybill=1234567890&pdf=true");
  assert.equal(result.status, 404);
  assert.equal(result.body.code, "LABEL_NOT_FOUND");
  assert.deepEqual(f.calls[0].options.params, { wbns: "1234567890", pdf: "True" });
});

test("legacy shipping cost fails closed when its feature flag is false or unset", async t => {
  for (const flag of ["false", undefined]) {
    await t.test(flag === undefined ? "missing flag" : "false flag", async t => {
      enableDelhiveryForTest(t, flag);
      const f = await fixture(t);
      const response = await f.request("/shipping-cost?md=S&ss=Delivered&d_pin=110001&o_pin=110002&cgm=1000&pt=Pre-paid");
      assert.equal(response.status, 503);
      assert.match(response.body.message, /disabled/i);
      assert.equal(f.calls.length, 0);
    });
  }
});

test("each direct Delhivery feature gate blocks its request when independently disabled", async t => {
  const f = await fixture(t);
  const previous = Object.values(DELHIVERY_FEATURES).map(name => [name, process.env[name]]);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const checks = [
    ["DELHIVERY_PINCODE_SERVICEABILITY_ENABLED", "/pincode?pincode=110001"],
    ["DELHIVERY_HEAVY_PINCODE_SERVICEABILITY_ENABLED", "/pincode/heavy?pincode=110001"],
    ["DELHIVERY_SHIPPING_COST_ENABLED", "/shipping-cost?md=S&ss=Delivered&d_pin=110001&o_pin=110002&cgm=1000&pt=Pre-paid"],
    ["DELHIVERY_EXPECTED_TAT_ENABLED", "/expected-tat?origin_pin=110001&destination_pin=110002&mot=S"],
    ["DELHIVERY_WAYBILL_ALLOCATION_ENABLED", "/waybills", { method: "POST", body: { count: 1 } }],
    ["DELHIVERY_LABELS_ENABLED", "/shipping-label?waybill=1234567890"],
    ["DELHIVERY_DOCUMENTS_ENABLED", "/documents?waybill=1234567890"],
    ["DELHIVERY_WAREHOUSE_CREATE_ENABLED", "/warehouses", { method: "POST", body: validWarehouse }],
    ["DELHIVERY_WAREHOUSE_UPDATE_ENABLED", "/warehouses/update", { method: "POST", body: validWarehouse }],
    ["DELHIVERY_PICKUP_CREATION_ENABLED", "/pickups", { method: "POST", body: { pickup_date: "2030-01-01", pickup_time: "10:00", pickup_location: { name: "Test Hub" }, expected_package_count: 1 } }],
    ["DELHIVERY_REVERSE_ORDERS_ENABLED", "/reverse-orders", { method: "POST", body: {} }],
  ];
  for (const [flag, path, options = {}] of checks) {
    for (const name of Object.values(DELHIVERY_FEATURES)) delete process.env[name];
    process.env[flag] = "false";
    const response = await f.request(path, options);
    assert.equal(response.status, flag === "DELHIVERY_WAREHOUSE_UPDATE_ENABLED" ? 404 : 503, flag);
    if (flag !== "DELHIVERY_WAREHOUSE_UPDATE_ENABLED") assert.equal(response.body.code, "DELHIVERY_FEATURE_DISABLED", flag);
  }
  assert.equal(f.calls.length, 0);
});

test("legacy shipping cost rejects zero, missing and invalid provider amounts", async t => {
  enableDelhiveryForTest(t);
  const f = await fixture(t);
  for (const payload of [[{ total_amount: 0 }], [{}], [{ total_amount: "not-a-number" }], [{ total_amount: -1 }]]) {
    f.setProviderGetResponse(payload);
    const response = await f.request("/shipping-cost?md=S&ss=Delivered&d_pin=110001&o_pin=110002&cgm=1000&pt=Pre-paid");
    assert.equal(response.status, 502);
    assert.equal(response.body.message, "Shipping provider returned no valid quotation.");
  }
  assert.equal(f.calls.length, 4);
});

test("labels and documents require a saved shipment owned by the caller", async t => {
  const f = await fixture(t);
  for (const path of ["/shipping-label?waybill=0987654321", "/documents?waybill=0987654321"]) {
    assert.equal((await f.request(path, { owner: "owner-a" })).status, 404);
  }
  assert.equal((await f.request("/shipping-label?waybill=1234567890")).body.success, true);
  assert.equal((await f.request("/documents?waybill=1234567890")).body.success, true);
  assert.equal(f.calls.length, 2);
});

test("warehouse listing is authenticated, owner-scoped, bounded and excludes provider receipts", async t => {
  const f = await fixture(t);
  const details = { ...validWarehouse };
  f.warehouses.push(
    { _id: "mongo-a", owner: "owner-a", name: "A Hub", nameKey: "a hub", state: "saved", registrationStatus: "REGISTERED", details, receipt: { private: "not returned" } },
    { _id: "mongo-b", owner: "owner-b", name: "B Hub", nameKey: "b hub", state: "saved", registrationStatus: "REGISTERED", details }
  );
  const response = await f.request("/warehouses");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.warehouses.map(row => row._id), ["mongo-a"]);
  assert.equal(response.body.data.warehouses[0].registrationStatus, "REGISTERED");
  assert.equal(response.body.data.warehouses[0].receipt, undefined);
  assert.equal((await f.request("/warehouses", { auth: false })).status, 401);
});

test("warehouse listing returns a stable empty result", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request("/warehouses")).body, { success: true, data: { warehouses: [], total: 0, limit: 200 } });
});

test("warehouse creation records server ownership and update success", async t => {
  const f = await fixture(t);
  enableDelhiveryForTest(t);
  f.setProviderResponse({ result: "mock", access_token: "must-not-be-persisted-or-returned" });
  const created = await f.request("/warehouses", { method: "POST", body: validWarehouse });
  assert.equal(created.status, 201);
  assert.equal(f.warehouses[0].owner, "owner-a");
  assert.equal(f.warehouses[0].state, "saved");
  assert.equal(f.warehouses[0].registrationStatus, "REGISTERED");
  assert.equal(created.body.warehouse._id, f.warehouses[0]._id);
  assert.equal(JSON.stringify(f.warehouses[0].receipt).includes("must-not"), false);
  assert.equal(JSON.stringify(created.body).includes("must-not"), false);
  assert.equal((await f.request("/warehouses/update", { owner: "owner-b", method: "POST", body: validWarehouse })).status, 404);
  assert.equal(f.calls.filter(call => call.path.includes("clientwarehouse/edit")).length, 0);
  const updated = await f.request("/warehouses/update", { method: "POST", body: { ...validWarehouse, address: "2 Main Road", city: "New Delhi" } });
  assert.equal(updated.status, 200);
  assert.equal(f.warehouses[0].details.city, "New Delhi");
  assert.equal(f.warehouses[0].registrationStatus, "REGISTERED");
  assert.equal(f.warehouses[0].updateStatus, "SUCCEEDED");
});

test("definitive registration rejection retains a FAILED warehouse reservation", async t => {
  const f = await fixture(t);
  enableDelhiveryForTest(t);
  f.failProvider(Object.assign(new Error("provider rejected"), { response: { status: 400, data: { error: "private" } } }));
  const response = await f.request("/warehouses", { method: "POST", body: validWarehouse });
  assert.equal(response.status, 502);
  assert.equal(response.body.code, "WAREHOUSE_REGISTRATION_FAILED");
  assert.equal(f.warehouses.length, 1);
  assert.equal(f.warehouses[0].registrationStatus, "FAILED");
  assert.equal(f.warehouseDeleteCalls, 0);
  assert.equal(JSON.stringify(response.body).includes("private"), false);
});

test("ambiguous registration failure is retained and never deleted", async t => {
  const f = await fixture(t);
  enableDelhiveryForTest(t);
  f.failProvider(new Error("mock timeout"));
  const response = await f.request("/warehouses", { method: "POST", body: validWarehouse });
  assert.equal(response.status, 502);
  assert.equal(response.body.code, "WAREHOUSE_OUTCOME_UNCONFIRMED");
  assert.equal(f.warehouses.length, 1);
  assert.equal(f.warehouses[0].registrationStatus, "OUTCOME_UNCONFIRMED");
  assert.equal(f.warehouseDeleteCalls, 0);
});

test("Mongo persistence failures do not trigger a provider retry or delete the reservation", async t => {
  const f = await fixture(t);
  enableDelhiveryForTest(t);
  f.failWarehouseUpdates();
  const response = await f.request("/warehouses", { method: "POST", body: validWarehouse });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "WAREHOUSE_OUTCOME_UNCONFIRMED");
  assert.equal(f.warehouses.length, 1);
  assert.equal(f.warehouses[0].registrationStatus, "CREATING");
  assert.equal(f.calls.filter(call => call.path.includes("clientwarehouse/create")).length, 1);
  assert.equal(f.warehouseDeleteCalls, 0);
});

test("failure to record an update prevents the provider request", async t => {
  const f = await fixture(t);
  enableDelhiveryForTest(t);
  const row = { _id: "existing-persist-fail", owner: "owner-a", name: validWarehouse.name, nameKey: "test hub", state: "saved", registrationStatus: "REGISTERED", details: { ...validWarehouse } };
  f.warehouses.push(row);
  f.failWarehouseUpdates();
  const response = await f.request("/warehouses/update", { method: "POST", body: { ...validWarehouse, address: "2 Main Road", city: "New Delhi" } });
  assert.equal(response.status, 503);
  assert.equal(f.calls.length, 0);
  assert.equal(row.details.city, "Delhi");
  assert.equal(row.registrationStatus, "REGISTERED");
});

test("disabled or missing configuration makes no warehouse create or update provider calls", async t => {
  for (const flag of ["false", undefined]) {
    await t.test(`flag ${String(flag)}`, async subtest => {
      const f = await fixture(subtest);
      enableDelhiveryForTest(subtest, flag);
      const created = await f.request("/warehouses", { method: "POST", body: validWarehouse });
      assert.equal(created.status, 503);
      assert.equal(f.warehouses.length, 0);
      f.warehouses.push({ _id: `existing-${String(flag)}`, owner: "owner-a", name: validWarehouse.name, nameKey: "test hub", state: "saved", registrationStatus: "REGISTERED", details: { ...validWarehouse } });
      const updated = await f.request("/warehouses/update", { method: "POST", body: { ...validWarehouse, address: "2 Main Road", city: "New Delhi" } });
      assert.equal(updated.status, 503);
      assert.equal(f.calls.length, 0);
      assert.equal(f.warehouses[0].details.city, "Delhi");
    });
  }
});

test("failed and uncertain updates preserve registered state, details and receipt", async t => {
  for (const [kind, expectedStatus, error] of [
    ["reject", "FAILED", Object.assign(new Error("rejected"), { response: { status: 400 } })],
    ["timeout", "OUTCOME_UNCONFIRMED", new Error("timeout")],
  ]) {
    const f = await fixture(t);
    enableDelhiveryForTest(t);
    const row = { _id: `existing-${kind}`, owner: "owner-a", name: validWarehouse.name, nameKey: "test hub", state: "saved", registrationStatus: "REGISTERED", details: { ...validWarehouse }, receipt: { previous: true } };
    f.warehouses.push(row);
    f.failProvider(error);
    const result = await f.request("/warehouses/update", { method: "POST", body: { ...validWarehouse, address: "2 Main Road", city: "New Delhi" } });
    assert.equal(result.status, 502);
    assert.equal(row.registrationStatus, "REGISTERED");
    assert.equal(row.updateStatus, expectedStatus);
    assert.equal(row.details.city, "New Delhi");
    assert.deepEqual(row.receipt, { previous: true });
    assert.equal(f.calls.filter(call => call.path.includes("clientwarehouse/edit")).length, 1);
  }
});

test("direct pickup creation uses the adapter and is blocked without Delhivery opt-in", async t => {
  const f = await fixture(t);
  const previousFlag = process.env.DELHIVERY_PICKUP_CREATION_ENABLED;
  t.after(() => {
    if (previousFlag === undefined) delete process.env.DELHIVERY_PICKUP_CREATION_ENABLED;
    else process.env.DELHIVERY_PICKUP_CREATION_ENABLED = previousFlag;
  });
  const body = { pickup_date: "2030-01-01", pickup_time: "10:00", pickup_location: { name: "Test Hub" }, expected_package_count: 1 };
  process.env.DELHIVERY_PICKUP_CREATION_ENABLED = "true";
  f.warehouses.push({ owner: "owner-a", name: "Test Hub", nameKey: "test hub", state: "saved" });
  f.setProviderResponse({ pickup_id: "mock-pickup-record" });
  f.shipments[0].record = { providerCode: "DELHIVERY" };
  const foreign = await f.request("/pickups", { method: "POST", body: { ...body, localDetails: { shipmentRefs: ["0987654321"] } } });
  assert.equal(foreign.status, 400);
  assert.equal(f.calls.length, 0);
  const created = await f.request("/pickups", { method: "POST", body: { ...body, localDetails: {
    pickupTimeTo: "13:00", instructions: "Local instructions", totalWeightKg: 2.5, shipmentRefs: ["1234567890"], shipmentCount: 1,
  } } });
  assert.equal(created.status, 201);
  assert.equal(f.calls[0].path, "/fm/request/new/");
  assert.equal(created.body.data.pickup.warehouse, "Test Hub");
  assert.equal(created.body.data.pickup.id, "mock-pickup-record");
  assert.equal(created.body.data.pickup.timeTo, "13:00:00");
  assert.equal(created.body.data.pickup.instructions, "Local instructions");
  assert.equal(created.body.data.pickup.totalWeightKg, 2.5);
  assert.equal(created.body.data.pickup.shipmentRefs[0].waybill, "1234567890");
  assert.equal(created.body.data.pickup.shipmentCount, 1);
  assert.deepEqual(Object.keys(f.calls[0].data).sort(), ["expected_package_count", "pickup_date", "pickup_location", "pickup_time"]);
  process.env.DELHIVERY_PICKUP_CREATION_ENABLED = "false";
  const calls = f.calls.length;
  const blocked = await f.request("/pickups", { method: "POST", body });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.code, "DELHIVERY_FEATURE_DISABLED");
  assert.equal(f.calls.length, calls);
});

test("legacy pickup rejects foreign warehouses and concurrent duplicate requests, including after uncertain responses", async t => {
  const f = await fixture(t);
  enableDelhiveryForTest(t);
  f.warehouses.push({ owner: "owner-a", name: "Test Hub", nameKey: "test hub", state: "saved", registrationStatus: "REGISTERED" });
  const body = { pickup_date: "2030-01-01", pickup_time: "10:00", pickup_location: { name: " test hub " }, expected_package_count: 1 };
  assert.equal((await f.request("/pickups", { owner: "owner-b", method: "POST", body })).status, 404);
  assert.equal(f.calls.length, 0);
  f.failProvider(new Error("simulated timeout"));
  const requests = await Promise.all([body, { ...body, pickup_time: "10:00:00" }].map(payload =>
    f.request("/pickups", { method: "POST", body: payload })));
  assert.deepEqual(requests.map(result => result.status).sort(), [409, 502]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].data.pickup_location, "Test Hub");
  assert.equal(f.calls[0].data.pickup_time, "10:00:00");
  assert.equal(f.pickups[0].carrierSubmissionStatus, "OUTCOME_UNCONFIRMED");
  assert.equal((await f.request("/pickups", { method: "POST", body })).status, 409);
  assert.equal(f.calls.length, 1);
});

test("invalid lookup and warehouse inputs stop before provider calls", async t => {
  const f = await fixture(t);
  for (const path of [
    "/pincode?pincode=abc", "/pincode/heavy?pincode=123", "/expected-tat?origin_pin=110001&destination_pin=abc",
    "/shipping-cost?md=S&ss=Delivered&d_pin=bad&o_pin=110002&cgm=1&pt=Pre-paid",
    "/shipping-label?waybill=123", "/documents?waybill=123",
  ]) assert.equal((await f.request(path)).status, 400, path);
  assert.equal((await f.request("/warehouses", { method: "POST", body: { ...validWarehouse, pin: "bad" } })).status, 400);
  assert.equal((await f.request("/warehouses/update", { method: "POST", body: { ...validWarehouse, pin: "bad" } })).status, 400);
  assert.equal((await f.request("/warehouses/update", { method: "POST", body: validWarehouse })).status, 404);
  assert.equal(f.calls.length, 0);
});

test("provider errors do not expose provider message or response body", async t => {
  const f = await fixture(t);
  f.failProvider(Object.assign(new Error("secret provider detail"), { response: { status: 400, data: { error: "private response" } } }));
  const response = await f.request("/pincode?pincode=110001");
  assert.equal(response.status, 502);
  assert.deepEqual(response.body, { success: false, code: "DELHIVERY_PINCODE_REQUEST_FAILED", message: "Delhivery pincode lookup failed (carrier HTTP 400)." });
  assert.equal(JSON.stringify(response.body).includes("private"), false);
});

test("configured pincode lookup uses Delhivery with mock booking and an unset read flag, without falling back on errors", async t => {
  const f = await fixture(t);
  const env = {
    APP_DEPLOYMENT_MODE: "uat",
    MOCK_COURIER_ADAPTER_ENABLED: "true",
    COURIER_DELHIVERY_ADAPTER_ENABLED: "false",
    DELHIVERY_PINCODE_SERVICEABILITY_ENABLED: "true",
    DELHIVERY_API_TOKEN: "route-test-token",
    DELHIVERY_BASE_URL: "https://delhivery.example.test",
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  f.setProviderGetResponse({ delivery_codes: [{ postal_code: { pin: 110001, pre_paid: "Y", cod: "Y", remarks: "Embargo" } }] });
  const response = await f.request("/pincode?pincode=110001");
  assert.equal(response.status, 200);
  assert.equal(response.body.provenance, "DELHIVERY_API");
  assert.equal(response.body.serviceable, false);
  assert.deepEqual(response.body.serviceability, { prepaid: false, cod: false });
  assert.equal(f.calls.length, 1);
  f.failProvider(Object.assign(new Error("private upstream response"), { response: { status: 401 } }));
  const failure = await f.request("/pincode?pincode=110001");
  assert.equal(failure.status, 502);
  assert.equal(failure.body.code, "DELHIVERY_PINCODE_REQUEST_FAILED");
  assert.match(failure.body.message, /carrier HTTP 401/);
  assert.equal(failure.body.provenance, undefined);
  process.env.DELHIVERY_PINCODE_SERVICEABILITY_ENABLED = "false";
  const disabled = await f.request("/pincode?pincode=110001");
  assert.equal(disabled.status, 503);
  assert.equal(disabled.body.code, "DELHIVERY_FEATURE_DISABLED");
  delete process.env.DELHIVERY_PINCODE_SERVICEABILITY_ENABLED;
  delete process.env.DELHIVERY_API_TOKEN;
  const unconfigured = await f.request("/pincode?pincode=110001");
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.code, "DELHIVERY_CONFIGURATION_ERROR");
  assert.equal(unconfigured.body.provenance, undefined);
  assert.equal(f.calls.length, 2);
});

test("legacy browser-only warehouse records cannot silently claim server ownership", async t => {
  const f = await fixture(t);
  const response = await f.request("/warehouses/update", { method: "POST", body: validWarehouse });
  assert.equal(response.status, 404);
  assert.match(response.body.message, /Legacy browser-saved warehouses must be verified/);
  assert.equal(f.calls.length, 0);
});
