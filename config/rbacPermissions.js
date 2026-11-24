// Stable permission vocabulary. Business role definitions remain pending until
// an approved policy is explicitly written through the RBAC admin workflow.
module.exports = Object.freeze([
  "dashboard.read",
  "search.read",
  "audit.read",
  "customers.read", "customers.manage",
  "rate_cards.read", "rate_cards.manage",
  "party_addresses.read", "party_addresses.manage",
  "shipments.read", "shipments.book", "shipments.update", "shipments.cancel", "shipments.ewaybill", "shipments.drafts.manage", "shipments.quote",
  "waybills.generate",
  "pickup_requests.read", "pickup_requests.schedule", "pickup_requests.manage", "pickup_requests.recover",
  "tracking.read", "tracking.sync",
  "ndr.read", "ndr.manage", "rto.read", "rto.manage",
  "billing.read", "billing.invoices.generate", "billing.payments.record",
  "partner_costs.read", "partner_costs.reconcile", "finance.reports.read",
  "warehouses.read", "warehouses.create", "warehouses.update",
  "delhivery.lookups", "delhivery.labels.read", "delhivery.documents.read",
  "reverse_orders.read", "reverse_orders.create",
  "scheduled_reports.read", "scheduled_reports.manage",
  "users.read", "users.permissions.manage",
]);
