const requireSession = require("./requireSession");
const User = require("../model/model");
const RbacPolicy = require("../model/rbacPolicy");
const permissionCatalog = require("../config/rbacPermissions");

const permissionSet = new Set(permissionCatalog);
const ROLE_KEY = /^[a-z][a-z0-9_-]{1,39}$/;

// Explicit method + route-template permissions for the routes mounted by
// server.js. Public authentication and provider webhook routes are listed
// explicitly with a null permission; all other unmatched requests are denied.
const declaredRoutePermissions = [
  ["POST", "/auth/register", null], ["POST", "/auth/login", null],
  ["GET", "/admin/rbac/users/:id/role", "users.read"],
  ["PATCH", "/admin/rbac/users/:id/role", "users.permissions.manage"],
  ["GET", "/admin/rbac/policy", "users.read"],
  ["PUT", "/admin/rbac/policy", "users.permissions.manage"],
  ["GET", "/admin/rbac/audit", "users.read"],
  ["GET", "/admin/pickup-diagnostics/:id", null],
  ["GET", "/audit", "audit.read"],
  ["GET", "/audit/integrations", "audit.read"],
  ["GET", "/search", "search.read"],
  ["GET", "/diagnostics/mock-courier", null],
  ["GET", "/config/direct-booking", null],

  ["GET", "/delhivery/pincode", "delhivery.lookups"],
  ["GET", "/delhivery/pincode/heavy", "delhivery.lookups"],
  ["GET", "/delhivery/expected-tat", "delhivery.lookups"],
  ["GET", "/delhivery/waybills", "waybills.generate"],
  ["POST", "/delhivery/waybills", "waybills.generate"],
  ["GET", "/delhivery/waybills/allocations/:requestId", "waybills.generate"],
  ["GET", "/delhivery/track", "tracking.read"],
  ["GET", "/delhivery/shipments/:id/tracking", "tracking.read"],
  ["POST", "/delhivery/shipments/:id/tracking/sync", "tracking.sync"],
  ["GET", "/delhivery/shipping-cost", "delhivery.lookups"],
  ["GET", "/delhivery/shipping-label", "delhivery.labels.read"],
  ["GET", "/delhivery/pickups", "pickup_requests.read"],
  ["POST", "/delhivery/pickups", "pickup_requests.schedule"],
  ["GET", "/delhivery/pickup-requests", "pickup_requests.read"],
  ["POST", "/delhivery/pickup-requests", "pickup_requests.schedule"],
  ["GET", "/delhivery/pickup-requests/:id", "pickup_requests.read"],
  ["PATCH", "/delhivery/pickup-requests/:id", "pickup_requests.manage"],
  ["POST", "/delhivery/pickup-requests/:id/cancel", "pickup_requests.manage"],
  ["DELETE", "/delhivery/pickup-requests/:id", "pickup_requests.manage"],
  ["POST", "/delhivery/pickup-requests/:id/status", "pickup_requests.manage"],
  ["POST", "/delhivery/pickup-requests/:id/sync", "pickup_requests.manage"],
  ["POST", "/delhivery/pickup-requests/:id/recover", "pickup_requests.recover"],
  ["POST", "/delhivery/pickup-requests/:id/cancel-failed", "pickup_requests.manage"],
  ["GET", "/delhivery/warehouses", "warehouses.read"],
  ["POST", "/delhivery/warehouses", "warehouses.create"],
  ["POST", "/delhivery/warehouses/update", "warehouses.update"],
  ["GET", "/delhivery/documents", "delhivery.documents.read"],
  ["POST", "/delhivery/webhook", null],
  ["GET", "/delhivery/webhook/events", "tracking.read"],
  ["GET", "/delhivery/dashboard/overview", "dashboard.read"],
  ["GET", "/delhivery/dashboard/action-required", "dashboard.read"],
  ["GET", "/delhivery/reverse-orders", "reverse_orders.read"],
  ["POST", "/delhivery/reverse-orders", "reverse_orders.create"],
  ["GET", "/delhivery/shipments/lookup", "shipments.read"],
  ["GET", "/delhivery/shipments", "shipments.read"],
  ["POST", "/delhivery/shipments", "shipments.book"],
  ["POST", "/delhivery/shipments/update", "shipments.update"],
  ["POST", "/delhivery/shipments/cancel", "shipments.cancel"],
  ["POST", "/delhivery/shipments/ewaybill", "shipments.ewaybill"],
  ["GET", "/delhivery/shipments/drafts", "shipments.read"],
  ["POST", "/delhivery/shipments/drafts", "shipments.drafts.manage"],
  ["GET", "/delhivery/shipments/drafts/:id", "shipments.read"],
  ["PATCH", "/delhivery/shipments/drafts/:id", "shipments.drafts.manage"],
  ["POST", "/delhivery/shipments/drafts/:id/quotes", "shipments.quote"],
  ["GET", "/delhivery/shipments/drafts/:id/booking-status", "shipments.read"],
  ["POST", "/delhivery/shipments/drafts/:id/book", "shipments.book"],
  ["POST", "/delhivery/shipments/drafts/:id/reconcile", "shipments.book"],
  ["POST", "/delhivery/shipments/drafts/:id/quotes/:quoteId/select", "shipments.quote"],
  ["POST", "/delhivery/ndr/cases/process", "ndr.manage"],
  ["GET", "/delhivery/ndr/cases", "ndr.read"],
  ["GET", "/delhivery/ndr/dashboard-cases", "ndr.read"],
  ["GET", "/delhivery/ndr/cases/:id", "ndr.read"],
  ["POST", "/delhivery/ndr/cases/:id/actions", "ndr.manage"],
  ["POST", "/delhivery/ndr/update", "ndr.manage"],
  ["GET", "/delhivery/ndr/status/:uplId", "ndr.read"],
  ["POST", "/delhivery/rto/cases/process", "rto.manage"],
  ["GET", "/delhivery/rto/cases", "rto.read"],
  ["GET", "/delhivery/rto/dashboard-cases", "rto.read"],
  ["GET", "/delhivery/rto/cases/:id", "rto.read"],
  ["POST", "/delhivery/rto/cases/:id/return-shipment", "rto.manage"],
  ["POST", "/delhivery/rto/cases/:id/sync", "rto.manage"],
  ["GET", "/delhivery/partner-costs", "partner_costs.read"],
  ["GET", "/delhivery/partner-costs/:shipmentId", "partner_costs.read"],
  ["POST", "/delhivery/partner-costs/:shipmentId/final", "partner_costs.reconcile"],

  ["GET", "/customers", "customers.read"], ["POST", "/customers", "customers.manage"],
  ["GET", "/customers/:id", "customers.read"], ["PATCH", "/customers/:id", "customers.manage"],
  ["GET", "/party-addresses", "party_addresses.read"], ["POST", "/party-addresses", "party_addresses.manage"],
  ["GET", "/party-addresses/:id", "party_addresses.read"], ["PATCH", "/party-addresses/:id", "party_addresses.manage"],
  ["POST", "/rate-cards/pricing-preview", "rate_cards.read"],
  ["GET", "/rate-cards", "rate_cards.read"], ["POST", "/rate-cards", "rate_cards.manage"],
  ["GET", "/rate-cards/:id", "rate_cards.read"], ["PATCH", "/rate-cards/:id", "rate_cards.manage"],
  ["POST", "/rate-cards/:id/versions", "rate_cards.manage"],
  ["GET", "/billing/credit-customers", "billing.read"],
  ["GET", "/billing/eligible-shipments", "billing.read"],
  ["GET", "/billing/invoices", "billing.read"],
  ["GET", "/billing/invoices/:id", "billing.read"],
  ["POST", "/billing/invoices/:id/adjustments", "billing.invoices.generate"],
  ["GET", "/billing/walk-in-payments", "billing.read"],
  ["POST", "/billing/walk-in-payments/:shipmentId", "billing.payments.record"],
  ["POST", "/billing/invoices", "billing.invoices.generate"],
  ["GET", "/billing/payment-invoices", "billing.read"],
  ["GET", "/billing/customers/:customerId/outstanding", "billing.read"],
  ["GET", "/billing/payments", "billing.read"],
  ["GET", "/billing/payments/:id", "billing.read"],
  ["POST", "/billing/payments", "billing.payments.record"],
  ["GET", "/finance/profitability", "finance.reports.read"],
  ["GET", "/finance/profitability/export.xlsx", "finance.reports.read"],
  ["GET", "/finance/profitability/export.pdf", "finance.reports.read"],
  ["GET", "/reports", "scheduled_reports.read"], ["POST", "/reports", "scheduled_reports.manage"],
  ["PATCH", "/reports/:id", "scheduled_reports.manage"], ["DELETE", "/reports/:id", "scheduled_reports.manage"],
];
// Express serves HEAD requests through GET handlers unless a separate HEAD
// handler is registered. Add that framework-supported method only for the
// explicitly declared GET templates; other methods remain unmapped.
const routePermissionMappings = Object.freeze(declaredRoutePermissions.flatMap(([method, path, permission]) =>
  method === "GET" ? [[method, path, permission], ["HEAD", path, permission]] : [[method, path, permission]]
));

function readQuery(query) {
  return query && typeof query.lean === "function" ? query.lean() : query;
}

function validateRoleMap(roles) {
  if (!roles || typeof roles !== "object" || Array.isArray(roles) || !Object.keys(roles).length) return null;
  const normalized = {};
  for (const [roleKey, permissions] of Object.entries(roles)) {
    if (!ROLE_KEY.test(roleKey) || !Array.isArray(permissions) || permissions.some(permission => typeof permission !== "string" || !permissionSet.has(permission))) return null;
    normalized[roleKey] = [...new Set(permissions)].sort();
  }
  return normalized;
}

async function readActivePolicy(PolicyModel = RbacPolicy) {
  const record = await readQuery(PolicyModel.findOne({ key: "active" }));
  if (!record) return { status: "pending", roles: null };
  const roles = validateRoleMap(record.roles);
  if (!roles) return { status: "invalid", roles: null };
  return { status: "active", roles, revision: record.revision || 1 };
}

function permissionForRequest(method, rawPath) {
  // Accept Express's single optional trailing slash, but don't collapse
  // malformed repeated separators into a valid route template.
  const path = (String(rawPath || "").split("?")[0].replace(/^\/api(?=\/|$)/i, "").replace(/\/$/, "") || "/").toLowerCase();
  const verb = String(method || "GET").toUpperCase();
  const segments = path === "/" ? [] : path.slice(1).split("/");
  const match = routePermissionMappings.find(([mappedMethod, template]) => {
    if (mappedMethod !== verb) return false;
    const templateSegments = template.toLowerCase() === "/" ? [] : template.slice(1).toLowerCase().split("/");
    return segments.length === templateSegments.length && templateSegments.every((segment, index) =>
      segment.startsWith(":") ? segments[index].length > 0 : segment === segments[index]
    );
  });
  return match ? match[2] : "rbac.unmapped";
}

function isRbacEnforcementEnabled() {
  return process.env.RBAC_ENFORCEMENT_ENABLED === "true";
}

function createRbacAuthorization({ UserModel = User, PolicyModel = RbacPolicy, enforce = isRbacEnforcementEnabled() } = {}) {
  return async function requireConfiguredPermission(req, res, next) {
    // RBAC can remain pending during client review. Individual application
    // routers retain their existing requireSession checks and owner filters.
    if (!enforce) return next();
    const permission = permissionForRequest(req.method, req.originalUrl || req.path);
    if (!permission) return next();
    return requireSession(req, res, async () => {
      let policy;
      let user;
      try {
        policy = await readActivePolicy(PolicyModel);
        if (policy.status !== "active") {
          return res.status(503).json({ success: false, code: policy.status === "pending" ? "RBAC_POLICY_PENDING" : "RBAC_POLICY_INVALID", message: policy.status === "pending" ? "Role permissions are awaiting approved configuration." : "Role permissions are not configured correctly." });
        }
        let userQuery = UserModel.findById(req.user.id);
        if (typeof userQuery?.select === "function") userQuery = userQuery.select("roleKey authzVersion active");
        user = await readQuery(userQuery);
      } catch {
        return res.status(503).json({ success: false, code: "RBAC_UNAVAILABLE", message: "Permissions could not be verified." });
      }
      if (!user || user.active === false) return res.status(403).json({ success: false, code: "ROLE_ASSIGNMENT_REQUIRED", message: "An approved role must be assigned to this account." });
      const roleKey = typeof user.roleKey === "string" ? user.roleKey : "";
      const permissions = policy.roles[roleKey];
      if (!permissions) return res.status(403).json({ success: false, code: "ROLE_ASSIGNMENT_REQUIRED", message: "An approved role must be assigned to this account." });
      if (!permissions.includes(permission)) return res.status(403).json({ success: false, code: "PERMISSION_DENIED", message: "Your assigned role does not allow this action." });
      req.authz = { roleKey, permissions, policyRevision: policy.revision };
      return next();
    });
  };
}

module.exports = { permissionCatalog, routePermissionMappings, validateRoleMap, readActivePolicy, permissionForRequest, isRbacEnforcementEnabled, createRbacAuthorization };
