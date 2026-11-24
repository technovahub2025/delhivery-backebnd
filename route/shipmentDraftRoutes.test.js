const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const makeRouter = require("../services/shipmentDraftRouter");

async function fixture(t) {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "draft-tests-only";
  const rows = [];
  const idA = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const idB = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const idAddr = "cccccccccccccccccccccccc";
  const idCard = "dddddddddddddddddddddddd";
  const idWarehouse = "eeeeeeeeeeeeeeeeeeeeeeee";
  const idForeignWarehouse = "ffffffffffffffffffffffff";
  const matches = (row, query) => Object.entries(query).every(([path, value]) => {
    if (path === "$or") return value.some(clause => matches(row, clause));
    const actual = path.split(".").reduce((target, key) => target?.[key], row);
    if (value && typeof value === "object" && "$in" in value) return value.$in.includes(actual ?? null);
    if (path === "createdAt") return (!value.$gte || actual >= value.$gte) && (!value.$lt || actual < value.$lt);
    return actual === value;
  });
  const Shipment = {
    find(query) {
      let offset = 0;
      let limit = Infinity;
      return {
        sort() { return this; },
        skip(value) { offset = value; return this; },
        limit(value) { limit = value; return this; },
        async lean() { return rows.filter(row => matches(row, query)).slice(offset, offset + limit); },
      };
    },
    async create(data) { const row = { ...data, _id: String(rows.length + 1).padStart(24, "0"), createdAt: new Date(), updatedAt: new Date() }; rows.push(row); return row; },
    findOne(query) { return { select() { return this; }, lean: async () => rows.find(row => matches(row, query)) || null }; },
    findOneAndUpdate(query, update) { return { lean: async () => { const row = rows.find(item => matches(item, query)); if (!row) return null; Object.assign(row, update.$set, { updatedAt: new Date() }); return row; } }; },
  };
  const Customer = { findOne: query => ({ lean: async () => query._id === idA && query.owner === "owner-a" ? { _id: idA, owner: "owner-a", category: "CREDIT", displayName: "Dummy Customer", rateCardId: idCard } : null }) };
  const PartyAddress = { findOne: query => ({ lean: async () => query._id === idAddr && query.owner === "owner-a" && query.partyType === "SHIPPER" ? { _id: idAddr, owner: "owner-a", customerId: idA, partyType: "SHIPPER", addressLines: ["Test Road"] } : null }) };
  const card = { _id: idCard, owner: "owner-a", scope: "CUSTOMER", customerId: idA, name: "Test Rate", version: 1 };
  const RateCard = { findOne: () => ({ select() { return this; }, lean: async () => card }) };
  const warehouse = { _id: idWarehouse, owner: "owner-a", name: "TEST-HUB", registrationStatus: "REGISTERED", details: { address: "Test Hub Road", pin: "400001", contact_name: "Test Contact", phone: "9000000000" } };
  const foreignWarehouse = { _id: idForeignWarehouse, owner: "owner-b", name: "FOREIGN-HUB", registrationStatus: "REGISTERED", details: { address: "Foreign Road", pin: "100001", phone: "9000000002" } };
  const Warehouse = { findOne: query => ({ lean: async () => {
    const row = [warehouse, foreignWarehouse].find(item => matches(item, query));
    return row ? structuredClone(row) : null;
  } }) };
  const carrier = { post: () => { throw new Error("Draft endpoint must never invoke carrier service"); } };
  const app = express(); app.use(express.json()); app.use(makeRouter({ Shipment, Customer, PartyAddress, RateCard, Warehouse, carrier }));
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret; });
  const request = async (path, owner = "owner-a", method = "GET", body) => {
    const token = owner && jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const formData = { reference: "TEST-ORDER", bookingCustomerId: idA, shipperAddressId: idAddr, warehouseId: idWarehouse, warehouse: "CLIENT-SUPPLIED-NAME", warehouseAddress: "CLIENT-SUPPLIED-ADDRESS", warehousePincode: "999999", warehouseContact: "CLIENT-SUPPLIED-CONTACT", warehousePhone: "9999999999", boxes: [{ boxes: 2, length: "20", width: "15", height: "10", weight: "500", unit: "cm", weightUnit: "gm", description: "Dummy goods" }], payment: "COD", value: "250", mode: "Surface", pickupChoice: "newAddress", pickupAddress: "Test pickup", shipperAddress: "Test Road" };
  const canonicalFormData = { ...formData, warehouse: "TEST-HUB", warehouseAddress: "Test Hub Road", warehousePincode: "400001", warehouseContact: "Test Contact", warehousePhone: "9000000000" };
  return { request, formData, canonicalFormData, rows, card, warehouse, foreignWarehouse, ids: { idA, idB, idAddr, idWarehouse, idForeignWarehouse } };
}

test("pending AWB date filters and pagination keep owner scope across pages", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 101; i++) {
    f.rows.push({ _id: String(i), owner: "owner-a", kind: "forward", state: "draft", createdAt: new Date("2026-09-30T23:59:59Z") });
  }
  f.rows.push({ ...f.rows[0], _id: "foreign", owner: "owner-b" });
  f.rows.push({ ...f.rows[0], _id: "outside", createdAt: new Date("2026-10-01T00:00:00Z") });
  const path = "/shipments/drafts?from=2026-09-30&to=2026-09-30";
  const first = (await f.request(path)).body.data;
  assert.equal(first.drafts.length, 100);
  assert.equal(first.hasMore, true);
  const second = (await f.request(path + "&page=2")).body.data;
  assert.deepEqual(second.drafts.map(row => row.id), ["100"]);
  assert.equal(second.hasMore, false);
  assert.equal((await f.request(path + "&page=0")).status, 400);
});

test("draft create and retrieval persist full form data and owner snapshots without carrier calls", async t => {
  const f = await fixture(t);
  const created = await f.request("/shipments/drafts", "owner-a", "POST", { formData: f.formData });
  assert.equal(created.status, 201);
  const id = created.body.data.draft.id;
  assert.deepEqual(created.body.data.draft.formData, f.canonicalFormData);
  assert.equal(created.body.data.draft.customerSnapshot.category, "CREDIT");
  assert.equal(created.body.data.draft.rateCardSnapshot.scope, "CUSTOMER");
  assert.equal(created.body.data.draft.pricingSnapshot.status, "CONFIGURATION_REQUIRED");
  assert.equal(created.body.data.draft.pricingSnapshot.partnerCost, null);
  assert.equal(created.body.data.draft.shipperSnapshot.addressLines[0], "Test Road");
  assert.equal(created.body.data.draft.warehouseSnapshot.pincode, "400001");
  assert.equal(created.body.data.draft.warehouseSnapshot.id, f.ids.idWarehouse);
  assert.equal(created.body.data.draft.warehouseSnapshot.registrationStatus, "REGISTERED");
  assert.deepEqual((await f.request(`/shipments/drafts/${id}`)).body.data.draft.formData, f.canonicalFormData);
  assert.equal((await f.request("/shipments/drafts")).body.data.drafts.length, 1);
});

test("draft accepts the populated registered-warehouse client payload while canonicalizing server-owned details", async t => {
  const f = await fixture(t);
  const populated = {
    ...f.formData,
    warehouseDetails: { name: "ABC Puducherry Warehouse", registrationStatus: "REGISTERED", pin: "605107" },
    registeredWarehouse: { id: f.ids.idWarehouse, name: "ABC Puducherry Warehouse" },
    warehouseRegistrationStatus: "REGISTERED",
    serviceability: { prepaid: true, cod: false },
  };
  const response = await f.request("/shipments/drafts", "owner-a", "POST", { formData: populated });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.draft.formData.warehouse, "TEST-HUB");
  assert.equal(response.body.data.draft.formData.warehouseDetails, undefined);
  assert.equal(response.body.data.draft.warehouseSnapshot.id, f.ids.idWarehouse);
});

test("owner can use a saved legacy warehouse without registrationStatus; another owner's saved warehouse is rejected", async t => {
  const f = await fixture(t);
  delete f.warehouse.registrationStatus;
  f.warehouse.state = "saved";
  const created = await f.request("/shipments/drafts", "owner-a", "POST", { formData: f.formData });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.draft.warehouseSnapshot.registrationStatus, "REGISTERED");

  f.foreignWarehouse.state = "saved";
  delete f.foreignWarehouse.registrationStatus;
  const rejected = await f.request("/shipments/drafts", "owner-a", "POST", {
    formData: { ...f.formData, reference: "FOREIGN-WAREHOUSE-ORDER", warehouseId: f.ids.idForeignWarehouse },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, "WAREHOUSE_INVALID");
});

test("draft accepts an owner-owned saved warehouse with a successful legacy registration receipt", async t => {
  const f = await fixture(t);
  delete f.warehouse.registrationStatus;
  f.warehouse.state = "saved";
  f.warehouse.receipt = { success: true, data: { message: "registered" } };
  const response = await f.request("/shipments/drafts", "owner-a", "POST", {
    formData: { ...f.formData, warehouseId: f.ids.idWarehouse },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.draft.warehouseSnapshot.id, f.ids.idWarehouse);
  assert.equal(response.body.data.draft.warehouseSnapshot.registrationStatus, "REGISTERED");
});

test("drafts retain product category, handling instructions and the fragile flag", async t => {
  const f = await fixture(t);
  const formData = { ...f.formData, productCategory: "  Glassware ", handlingInstructions: " Keep upright ", fragile: true };
  const created = await f.request("/shipments/drafts", "owner-a", "POST", { formData });
  assert.equal(created.status, 201);
  const saved = await f.request(`/shipments/drafts/${created.body.data.draft.id}`);
  assert.equal(saved.body.data.draft.formData.productCategory, "Glassware");
  assert.equal(saved.body.data.draft.formData.handlingInstructions, "Keep upright");
  assert.equal(saved.body.data.draft.formData.fragile, true);
  assert.equal((await f.request("/shipments/drafts", "owner-a", "POST", { formData: { ...formData, fragile: "yes" } })).status, 400);
});

test("draft updates persist changes and cannot be read or changed by a different owner", async t => {
  const f = await fixture(t);
  const created = await f.request("/shipments/drafts", "owner-a", "POST", { formData: f.formData });
  const id = created.body.data.draft.id;
  f.card.version = 2;
  const changed = { ...f.formData, reference: "UPDATED-ORDER", description: "Updated test contents", destinationZone: "DUMMY-ZONE" };
  assert.equal((await f.request(`/shipments/drafts/${id}`, "owner-a", "PATCH", { formData: changed })).status, 200);
  assert.equal((await f.request(`/shipments/drafts/${id}`, "owner-a")).body.data.draft.formData.reference, "UPDATED-ORDER");
  assert.equal((await f.request(`/shipments/drafts/${id}`, "owner-a")).body.data.draft.pricingSnapshotHistory.length, 1);
  assert.equal((await f.request(`/shipments/drafts/${id}`, "owner-b")).status, 404);
  assert.equal((await f.request(`/shipments/drafts/${id}`, "owner-b", "PATCH", { formData: changed })).status, 404);
  assert.equal((await f.request("/shipments/drafts", "owner-b")).body.data.drafts.length, 0);
});

test("draft endpoints require authentication and reject malformed form or foreign references", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/shipments/drafts", null)).status, 401);
  assert.equal((await f.request("/shipments/drafts", "owner-a", "POST", { formData: [] })).status, 400);
  assert.equal((await f.request("/shipments/drafts", "owner-a", "POST", { formData: { boxes: [] } })).status, 400);
  assert.equal((await f.request("/shipments/drafts", "owner-a", "POST", { formData: { bookingCustomerId: f.ids.idB } })).status, 400);
});

test("draft rejects a saved address not owned for the selected party/customer", async t => {
  const f = await fixture(t);
  const bad = { ...f.formData, consigneeAddressId: f.ids.idB };
  assert.equal((await f.request("/shipments/drafts", "owner-a", "POST", { formData: bad })).status, 400);
});

for (const registrationStatus of ["FAILED", "CREATING", "OUTCOME_UNCONFIRMED"]) test(`draft creation rejects warehouse registration status ${registrationStatus}`, async t => {
  const f = await fixture(t);
  f.warehouse.registrationStatus = registrationStatus;
  const response = await f.request("/shipments/drafts", "owner-a", "POST", { formData: f.formData });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "WAREHOUSE_INVALID");
  assert.equal(f.rows.length, 0);
});

test("draft creation rejects missing, nonexistent and another owner's warehouse IDs", async t => {
  const f = await fixture(t);
  for (const warehouseId of [undefined, f.ids.idB, f.ids.idForeignWarehouse]) {
    const formData = { ...f.formData };
    if (warehouseId === undefined) delete formData.warehouseId;
    else formData.warehouseId = warehouseId;
    const response = await f.request("/shipments/drafts", "owner-a", "POST", { formData });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "WAREHOUSE_INVALID");
  }
  assert.equal(f.rows.length, 0);
});

test("draft edits revalidate warehouse ownership and registration", async t => {
  const f = await fixture(t);
  const created = await f.request("/shipments/drafts", "owner-a", "POST", { formData: f.formData });
  const id = created.body.data.draft.id;
  f.warehouse.registrationStatus = "FAILED";
  const updated = await f.request(`/shipments/drafts/${id}`, "owner-a", "PATCH", { formData: f.formData });
  assert.equal(updated.status, 400);
  assert.equal(updated.body.code, "WAREHOUSE_INVALID");
  assert.equal(f.rows[0].draftData.formData.warehouse, "TEST-HUB");
});

test("editing a draft archives quote batches and clears current manual selection", async t => {
  const f = await fixture(t);
  const created = await f.request("/shipments/drafts", "owner-a", "POST", { formData: f.formData });
  const id = created.body.data.draft.id;
  const row = f.rows[0];
  row.draftData.partnerQuoteBatches = [{ id: "batch-old", quotes: [{ id: "quote-old" }], archived: false }];
  row.draftData.activePartnerQuoteBatchId = "batch-old";
  row.draftData.selectedPartnerQuote = { id: "quote-old" };
  const changed = { ...f.formData, description: "Updated dummy goods" };
  const response = await f.request(`/shipments/drafts/${id}`, "owner-a", "PATCH", { formData: changed });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.draft.partnerQuoteBatches[0].archived, true);
  assert.equal(response.body.data.draft.selectedPartnerQuote, null);
  assert.equal(row.draftData.activePartnerQuoteBatchId, null);
});

test("creating booking attempts remain visible and retrievable after reload", async t => {
  const f = await fixture(t);
  const created = await f.request("/shipments/drafts", "owner-a", "POST", { formData: f.formData });
  const id = created.body.data.draft.id;
  const row = f.rows[0];
  row.state = "creating";
  row.draftData.bookingAttempt = { status: "OUTCOME_UNCONFIRMED", partnerCode: "MOCK", idempotencyKey: "mock-key" };
  const list = await f.request("/shipments/drafts", "owner-a");
  assert.equal(list.body.data.drafts[0].id, id);
  assert.equal(list.body.data.drafts[0].bookingAttempt.status, "OUTCOME_UNCONFIRMED");
  assert.equal((await f.request(`/shipments/drafts/${id}`, "owner-a")).body.data.draft.state, "creating");
});



