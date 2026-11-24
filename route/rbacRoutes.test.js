const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const createRbacRoutes = require("./rbacRoutes");
const { createRbacAuthorization, permissionForRequest, permissionCatalog, routePermissionMappings } = require("../utils/rbacAuthorization");
const createShipmentRouter = require("../services/appShipmentRouter");
const { createTrackingWebhookController } = require("../controller/trackingWebhookController");
const requireSession = require("../utils/requireSession");

const SECRET = "rbac-route-tests-only";
const idA = "64b000000000000000000001";
const idB = "64b000000000000000000002";

function makeQuery(value) {
  return { select() { return this; }, session() { return this; }, lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}

async function start(t, { users = [], roles = null, withAdminRoutes = false, shipments = [], withWebhookRoute = false, rbacEnabled = true } = {}) {
  process.env.JWT_SECRET = SECRET;
  const previousRbacSetting = process.env.RBAC_ENFORCEMENT_ENABLED;
  process.env.RBAC_ENFORCEMENT_ENABLED = rbacEnabled ? "true" : "false";
  const userMap = new Map(users.map(user => [String(user._id), { ...user }]));
  const policyRef = { record: roles ? { key: "active", revision: 1, roles } : null };
  const auditRows = [];
  let policyReads = 0;
  const UserModel = {
    findById(id) { return makeQuery(userMap.get(String(id)) || null); },
    async updateOne(query, update) {
      const row = userMap.get(String(query._id));
      if (!row || (query.$or && row.roleKey != null) || (query.roleKey && row.roleKey !== query.roleKey)) return { matchedCount: 0 };
      Object.assign(row, update.$set);
      row.authzVersion = (row.authzVersion || 0) + (update.$inc?.authzVersion || 0);
      return { matchedCount: 1 };
    },
  };
  const PolicyModel = {
    findOne() { policyReads += 1; return makeQuery(policyRef.record); },
    async findOneAndUpdate(query, update) {
      policyRef.record = { key: "active", revision: (policyRef.record?.revision || 0) + (update.$inc?.revision || 0), roles: update.$set.roles, updatedBy: update.$set.updatedBy };
      return policyRef.record;
    },
  };
  const AuditModel = {
    async create(data) { const row = { ...data, _id: String(auditRows.length + 1), createdAt: new Date() }; auditRows.push(row); return row; },
    async updateOne(query, update) { const row = auditRows.find(item => item._id === query._id); if (row) Object.assign(row, update.$set); return { matchedCount: row ? 1 : 0 }; },
    find() { return { sort() { return this; }, limit() { return this; }, lean() { return Promise.resolve(auditRows); } }; },
  };
  const Shipment = {
    countDocuments: async filter => shipments.filter(row => row.owner === filter.owner && row.state === filter.state).length,
    find(filter) {
      let skip = 0; let limit = 100;
      return { sort() { return this; }, skip(value) { skip = value; return this; }, limit(value) { limit = value; return this; }, lean: async () => shipments.filter(row => row.owner === filter.owner && row.state === filter.state).slice(skip, skip + limit) };
    },
  };
  const app = express(); app.use(express.json());
  app.use("/api", createRbacAuthorization({ UserModel, PolicyModel }));
  if (withAdminRoutes) app.use("/api/admin/rbac", createRbacRoutes({ UserModel, PolicyModel, AuditModel }));
  else if (!shipments.length) app.get("/api/delhivery/shipments", requireSession, (req, res) => res.json({ success: true, role: req.authz?.roleKey || null, owner: req.user.id }));
  if (shipments.length) app.use("/api/delhivery", createShipmentRouter({ Shipment, Warehouse: { findOne: () => makeQuery(null) }, carrier: { post: async () => ({ data: {} }) } }));
  if (withWebhookRoute) app.post("/api/delhivery/webhook", createTrackingWebhookController({ enabled: false }));
  const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); });
    if (previousRbacSetting === undefined) delete process.env.RBAC_ENFORCEMENT_ENABLED;
    else process.env.RBAC_ENFORCEMENT_ENABLED = previousRbacSetting;
  });
  const request = async (path, { owner = idA, method = "GET", body, auth = true } = {}) => {
    const token = auth ? jwt.sign({ id: owner }, SECRET, { expiresIn: "1h" }) : null;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { request, users: userMap, policyRef, auditRows, get policyReads() { return policyReads; } };
}

const readRole = ["shipments.read", "tracking.read", "delhivery.documents.read"];
const basePolicy = { reader: readRole, manager: ["users.read", "users.permissions.manage"] };

test("every declared mounted route template has one exact permission mapping", () => {
  assert.ok(routePermissionMappings.length > 100);
  const seen = new Set();
  for (const [method, template, permission] of routePermissionMappings) {
    const key = `${method} ${template}`;
    assert.equal(seen.has(key), false, `duplicate mapping ${key}`);
    seen.add(key);
    assert.ok(permission === null || permission === "rbac.unmapped" || permissionCatalog.includes(permission), key);
    const concretePath = template.replace(/:[A-Za-z][A-Za-z0-9_]*/g, "sample-id");
    assert.equal(permissionForRequest(method, `/api${concretePath}`), permission, key);
  }
  assert.equal(permissionForRequest("GET", "/api/billing/invoices/abc"), "billing.read");
  assert.equal(permissionForRequest("POST", "/api/billing/invoices"), "billing.invoices.generate");
  assert.equal(permissionForRequest("POST", "/api/billing/payments"), "billing.payments.record");
  assert.equal(permissionForRequest("GET", "/api/finance/profitability"), "finance.reports.read");
  assert.equal(permissionForRequest("POST", "/api/delhivery/warehouses"), "warehouses.create");
  assert.equal(permissionForRequest("POST", "/api/delhivery/warehouses/update"), "warehouses.update");
  assert.equal(permissionForRequest("PATCH", "/api/delhivery/pickup-requests/abc"), "pickup_requests.manage");
  assert.equal(permissionCatalog.includes("users.permissions.manage"), true);
  for (const [path, permission] of [
    ["/search", "search.read"],
    ["/delhivery/warehouses", "warehouses.read"],
    ["/delhivery/ndr/dashboard-cases", "ndr.read"],
    ["/delhivery/rto/dashboard-cases", "rto.read"],
    ["/finance/profitability/export.xlsx", "finance.reports.read"],
    ["/finance/profitability/export.pdf", "finance.reports.read"],
  ]) {
    assert.equal(permissionForRequest("GET", "/api" + path), permission);
    assert.equal(permissionForRequest("HEAD", "/api" + path), permission);
  }
});

test("only explicit login and registration routes are public; unknown auth routes are unmapped", () => {
  assert.equal(permissionForRequest("POST", "/api/auth/login"), null);
  assert.equal(permissionForRequest("POST", "/api/auth/register"), null);
  assert.equal(permissionForRequest("GET", "/api/auth/login"), "rbac.unmapped");
  assert.equal(permissionForRequest("POST", "/api/auth/reset-password"), "rbac.unmapped");
  assert.equal(permissionForRequest("GET", "/api/auth/anything"), "rbac.unmapped");
});

test("unknown routes under known prefixes and unsupported methods fail closed", () => {
  for (const path of [
    "/api/billing/invoice-admin", "/api/billing/unknown/path", "/api/customers/abc/permissions",
    "/api/rate-cards/abc/delete", "/api/delhivery/ndr/unknown", "/api/delhivery/shipments/draftsish",
    "/api/delhivery/partner-costs/abc/export", "/api/reports/abc/history", "/api/customers//", "/api/customers///",
  ]) assert.equal(permissionForRequest("GET", path), "rbac.unmapped", path);
  for (const [method, path] of [
    ["PUT", "/api/billing/invoices"], ["DELETE", "/api/customers"], ["PATCH", "/api/delhivery/shipments"],
    ["GET", "/api/delhivery/webhook"], ["OPTIONS", "/api/delhivery/pincode"],
  ]) assert.equal(permissionForRequest(method, path), "rbac.unmapped", `${method} ${path}`);
  // Express implicitly supports HEAD for GET routes; only those exact templates map.
  assert.equal(permissionForRequest("HEAD", "/api/customers"), "customers.read");
  assert.equal(permissionForRequest("HEAD", "/api/customers/abc/extra"), "rbac.unmapped");
  assert.equal(permissionForRequest("GET", "/api/customers/"), "customers.read");
});

test("unknown and unsupported HTTP requests are denied even for a role with related read access", async t => {
  const f = await start(t, { roles: { reader: ["shipments.read", "billing.read", "ndr.read"] }, users: [{ _id: idA, roleKey: "reader" }] });
  for (const [method, path] of [
    ["GET", "/api/billing/invoice-admin"],
    ["GET", "/api/delhivery/ndr/unknown"],
    ["DELETE", "/api/delhivery/shipments"],
    ["PUT", "/api/billing/invoices"],
  ]) {
    const response = await f.request(path, { method });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal(response.body.code, "PERMISSION_DENIED");
  }
});

test("Delhivery webhook reaches its independent fail-closed handler without RBAC session checks", async t => {
  const f = await start(t, { withWebhookRoute: true });
  const response = await f.request("/api/delhivery/webhook", { method: "POST", auth: false, body: {} });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "WEBHOOK_PROCESSING_DISABLED");
  assert.equal(f.policyReads, 0);
});

test("rejects unauthenticated calls and leaves absent policy pending", async t => {
  const f = await start(t, { users: [{ _id: idA, roleKey: "reader" }] });
  assert.equal((await f.request("/api/delhivery/shipments", { auth: false })).status, 401);
  const pending = await f.request("/api/delhivery/shipments");
  assert.equal(pending.status, 503);
  assert.equal(pending.body.code, "RBAC_POLICY_PENDING");
});

test("RBAC disabled restores authenticated application flow without requiring an active policy", async t => {
  const f = await start(t, { rbacEnabled: false, users: [{ _id: idA }] });
  assert.equal((await f.request("/api/delhivery/shipments", { auth: false })).status, 401);
  const response = await f.request("/api/delhivery/shipments");
  assert.equal(response.status, 200);
  assert.equal(response.body.owner, idA);
  assert.equal(response.body.role, null);
  assert.equal(f.policyReads, 0);
});

test("RBAC admin routes retain their configured permissions while global enforcement is disabled", async t => {
  const roles = { manager: ["users.read", "users.permissions.manage"] };
  const f = await start(t, { rbacEnabled: false, withAdminRoutes: true, roles, users: [{ _id: idA, roleKey: "manager", active: true }] });
  const response = await f.request("/api/admin/rbac/policy");
  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, "active");
});

test("existing users and old JWTs authenticate but receive no permissions until explicitly assigned", async t => {
  const f = await start(t, { roles: basePolicy, users: [{ _id: idA }] });
  const response = await f.request("/api/delhivery/shipments");
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "ROLE_ASSIGNMENT_REQUIRED");
});

test("a configured permission authorizes the request while missing permission is denied", async t => {
  const f = await start(t, { roles: basePolicy, users: [{ _id: idA, roleKey: "reader" }] });
  assert.equal((await f.request("/api/delhivery/shipments")).status, 200);
  const denied = await f.request("/api/delhivery/shipments", { method: "POST", body: {} });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "PERMISSION_DENIED");
});

test("RBAC enforcement preserves shipment owner isolation", async t => {
  const f = await start(t, { roles: { reader: ["shipments.read"] }, users: [{ _id: idA, roleKey: "reader" }, { _id: idB, roleKey: "reader" }], shipments: [
    { owner: idA, state: "saved", reference: "A", record: { reference: "A" } },
    { owner: idB, state: "saved", reference: "B", record: { reference: "B" } },
  ] });
  const response = await f.request("/api/delhivery/shipments", { owner: idA });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.shipments.map(row => row.reference), ["A"]);
});

test("RBAC disabled still preserves owner isolation in the existing shipment route", async t => {
  const f = await start(t, { rbacEnabled: false, shipments: [
    { owner: idA, state: "saved", reference: "A", record: { reference: "A" } },
    { owner: idB, state: "saved", reference: "B", record: { reference: "B" } },
  ] });
  assert.equal((await f.request("/api/delhivery/shipments", { auth: false })).status, 401);
  const response = await f.request("/api/delhivery/shipments", { owner: idA });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.shipments.map(row => row.reference), ["A"]);
  assert.equal(f.policyReads, 0);
});

test("role changes require audit, block self-assignment, and prevent privilege escalation", async t => {
  const roles = { manager: ["users.read", "users.permissions.manage"], reader: [], elevated: ["users.read", "users.permissions.manage", "shipments.book"] };
  const f = await start(t, { withAdminRoutes: true, roles, users: [
    { _id: idA, roleKey: "manager" }, { _id: idB, roleKey: null },
  ] });
  const self = await f.request(`/api/admin/rbac/users/${idA}/role`, { method: "PATCH", body: { role: "reader", reason: "test" } });
  assert.equal(self.status, 409);
  const escalation = await f.request(`/api/admin/rbac/users/${idB}/role`, { method: "PATCH", body: { role: "elevated", reason: "test" } });
  assert.equal(escalation.status, 403);
  assert.equal(escalation.body.code, "ROLE_ESCALATION_BLOCKED");
  const assigned = await f.request(`/api/admin/rbac/users/${idB}/role`, { method: "PATCH", body: { role: "reader", reason: "approved test assignment" } });
  assert.equal(assigned.status, 200);
  assert.equal(f.users.get(idB).roleKey, "reader");
  assert.equal(f.users.get(idB).authzVersion, 1);
  assert.equal(f.auditRows.at(-1).outcome, "succeeded");
});

test("role administration cannot save a policy against a stale revision", async t => {
  const roles = { manager: ["users.read", "users.permissions.manage"], reader: [] };
  const f = await start(t, { withAdminRoutes: true, roles, users: [{ _id: idA, roleKey: "manager" }] });
  const stale = await f.request("/api/admin/rbac/policy", { method: "PUT", body: { roles, reason: "Approved permissions", revision: 2 } });
  assert.equal(stale.status, 409);
  const current = await f.request("/api/admin/rbac/policy", { method: "PUT", body: { roles, reason: "Approved permissions", revision: 1 } });
  assert.equal(current.status, 200);
  assert.equal(current.body.data.revision, 2);
});

test("permission matrix updates are audited and cannot grant beyond the editor", async t => {
  const roles = { manager: ["users.read", "users.permissions.manage"], reader: [] };
  const f = await start(t, { withAdminRoutes: true, roles, users: [{ _id: idA, roleKey: "manager" }] });
  const denied = await f.request("/api/admin/rbac/policy", { method: "PUT", body: { roles: { manager: [...roles.manager, "finance.reports.read"] }, reason: "test" } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "POLICY_ESCALATION_BLOCKED");
  const saved = await f.request("/api/admin/rbac/policy", { method: "PUT", body: { roles, reason: "approved test policy update" } });
  assert.equal(saved.status, 200);
  assert.equal(f.policyRef.record.revision, 2);
  assert.equal(f.auditRows.at(-1).action, "rbac.policy.update");
  assert.equal(f.auditRows.at(-1).outcome, "succeeded");
});

test("user without permission cannot access finance or warehouse routes", async t => {
  const f = await start(t, { roles: { reader: ["shipments.read"] }, users: [{ _id: idA, roleKey: "reader" }] });
  for (const [path, method, body] of [
    ["/api/billing/invoices", "POST", {}], ["/api/billing/payments", "POST", {}],
    ["/api/finance/profitability", "GET"], ["/api/delhivery/warehouses", "POST", {}],
    ["/api/delhivery/pincode?pincode=110001", "GET"], ["/api/delhivery/documents?waybill=1234567890", "GET"],
  ]) {
    const response = await f.request(path, { method, ...(body ? { body } : {}) });
    assert.equal(response.status, 403, path);
  }
});
