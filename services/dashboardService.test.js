const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getDashboardOverview } = require("./dashboardService");
const { validateMappings } = require("./providerStatusMappings");
const mappings = validateMappings({ MOCK: {
  shipment: { "In Transit": "IN_TRANSIT", Delivered: "DELIVERED", Failed: "FAILED", Exception: "EXCEPTION" },
  rtoTrigger: { "RTO In Transit": "RTO_TRIGGER" },
  rto: { "RTO In Transit": "ACTIVE", "Return Delivered": "COMPLETED", "Return Status Unknown": "UNRESOLVED" },
} });

function model(records) {
  return { find(query) {
    const matches = records.filter(row => Object.entries(query).every(([key, expected]) => {
      if (expected?.$in) return expected.$in.includes(row[key]);
      if (key === "owner" || key === "state") return String(row[key] || "") === String(expected);
      const actual = row[key];
      if (expected && typeof expected === "object") return (!expected.$gte || new Date(actual) >= expected.$gte) && (!expected.$lt || new Date(actual) < expected.$lt);
      return String(actual || "") === String(expected);
    }));
    return { lean: async () => structuredClone(matches) };
  } };
}

test("dashboard aggregates owner-scoped shipment, pickup, NDR and RTO data without double-counting", async () => {
  const Shipment = model([
    { _id: "s1", owner: "a", state: "saved", reference: "R1", record: { partnerCode: "MOCK" }, trackingStatus: "In Transit", createdAt: new Date("2026-09-01"), trackingEvents: [{ eventKey: "e1", providerCode: "MOCK", status: "In Transit", occurredAt: new Date("2026-09-02") }] },
    { _id: "s2", owner: "a", state: "saved", reference: "R2", record: { partnerCode: "MOCK" }, trackingStatus: "Delivered", createdAt: new Date("2026-09-02"), trackingEvents: [] },
    { _id: "s3", owner: "b", state: "saved", record: { partnerCode: "MOCK" }, trackingStatus: "Delivered", createdAt: new Date("2026-09-02") },
    { _id: "draft", owner: "a", state: "draft", trackingStatus: "In Transit", createdAt: new Date("2026-09-02") },
  ]);
  const PickupRequest = model([
    { _id: "p1", owner: "a", status: "Pending", createdAt: new Date("2026-09-01"), history: [] },
    { _id: "p2", owner: "a", status: "Completed", createdAt: new Date("2026-09-01"), history: [] },
    { _id: "p3", owner: "b", status: "Pending", createdAt: new Date("2026-09-01"), history: [] },
  ]);
  const NdrCase = model([
    { _id: "n1", owner: "a", shipment: "s1", trackingEventKey: "ndr-1", status: "OPEN", occurredAt: new Date("2026-09-02"), reason: "Test" },
    { _id: "n2", owner: "a", shipment: "s1", trackingEventKey: "ndr-2", status: "RESOLVED", occurredAt: new Date("2026-09-02") },
    { _id: "n3", owner: "b", shipment: "s3", trackingEventKey: "ndr-3", status: "OPEN", occurredAt: new Date("2026-09-02") },
  ]);
  const RtoRecord = model([{ _id: "r1", owner: "a", originalShipment: "s1", providerCode: "MOCK", lifecycleState: "ACTIVE", status: "RTO In Transit", occurredAt: new Date("2026-09-02"), reason: "Test return" }]);
  const result = await getDashboardOverview({ Shipment, PickupRequest, NdrCase, RtoRecord }, "a", { statusMappings: mappings });
  assert.equal(result.metrics.totalShipments, 2);
  assert.equal(result.metrics.pendingPickups, 1);
  assert.equal(result.metrics.inTransitShipments, 1);
  assert.equal(result.metrics.deliveredShipments, 1);
  assert.equal(result.metrics.undeliveredShipments, 1);
  assert.equal(result.metrics.ndrShipments, 1);
  assert.equal(result.metrics.unresolvedNdrCases, 1);
  assert.equal(result.metrics.rtoShipments, 1);
  assert.equal(result.metrics.activeRtoCases, 1);
  assert.equal(result.metrics.completedRtoCases, 0);
  assert.equal(result.metrics.unresolvedRtoCases, 0);
  assert.equal(result.availability.rtoLifecycleMetrics.available, true);
  assert.equal(result.pickupSummary.total, 2);
});

test("dashboard date and status filters constrain summary and recent history", async () => {
  const base = { Shipment: model([
    { _id: "s1", owner: "a", state: "saved", record: { partnerCode: "MOCK" }, trackingStatus: "Delivered", createdAt: new Date("2026-09-01T10:00:00Z"), trackingEvents: [] },
    { _id: "s2", owner: "a", state: "saved", record: { partnerCode: "MOCK" }, trackingStatus: "In Transit", createdAt: new Date("2026-09-03T10:00:00Z"), trackingEvents: [] },
  ]), PickupRequest: model([]), NdrCase: model([]), RtoRecord: model([]) };
  const result = await getDashboardOverview(base, "a", { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-02T00:00:00Z"), status: "delivered", statusMappings: mappings });
  assert.equal(result.metrics.totalShipments, 1);
  assert.equal(result.metrics.deliveredShipments, 1);
  assert.equal(result.filters.status, "delivered");
  assert.equal(result.recentActivity.length, 1);
});

test("dashboard delivered and in-transit counts use only mapped forward shipment statuses", async () => {
  const Shipment = model([
    { _id: "delivered", owner: "a", state: "saved", kind: "forward", record: { partnerCode: "MOCK", status: "Pending pickup" }, trackingStatus: "Delivered", createdAt: new Date("2026-09-01"), trackingEvents: [] },
    { _id: "transit", owner: "a", state: "saved", kind: "forward", record: { partnerCode: "MOCK", status: "In Transit" }, createdAt: new Date("2026-09-01"), trackingEvents: [] },
    { _id: "unknown", owner: "a", state: "saved", kind: "forward", record: { partnerCode: "MOCK", status: "New provider state" }, createdAt: new Date("2026-09-01"), trackingEvents: [] },
    { _id: "reverse-delivered", owner: "a", state: "saved", kind: "reverse", record: { partnerCode: "MOCK", status: "Delivered" }, createdAt: new Date("2026-09-01"), trackingEvents: [] },
  ]);
  const deps = { Shipment, PickupRequest: model([]), NdrCase: model([]), RtoRecord: model([]) };
  const delivered = await getDashboardOverview(deps, "a", { status: "delivered", statusMappings: mappings });
  const transit = await getDashboardOverview(deps, "a", { status: "inTransit", statusMappings: mappings });
  const all = await getDashboardOverview(deps, "a", { statusMappings: mappings });
  assert.equal(delivered.metrics.totalShipments, 1);
  assert.equal(delivered.metrics.deliveredShipments, 1);
  assert.equal(transit.metrics.totalShipments, 1);
  assert.equal(transit.metrics.inTransitShipments, 1);
  assert.equal(all.metrics.totalShipments, 3);
  assert.equal(all.deliverySummary.unclassified, 1);
});

test("pending AWB counts owner drafts, unresolved attempts and confirmed forward bookings without an AWB", async () => {
  const Shipment = model([
    { _id: "pending-a", owner: "a", state: "saved", kind: "forward", waybill: "", record: { bookingStatus: "BOOKED_AWB_PENDING", waybill: "" }, createdAt: new Date("2026-09-01T10:00:00Z") },
    { _id: "pending-legacy", owner: "a", state: "saved", record: { bookingStatus: "BOOKED_AWB_PENDING" }, createdAt: new Date("2026-09-01T11:00:00Z") },
    { _id: "already-has-awb", owner: "a", state: "saved", kind: "forward", waybill: "AWB-1", record: { bookingStatus: "BOOKED_AWB_PENDING" }, createdAt: new Date("2026-09-01T12:00:00Z") },
    { _id: "record-has-awb", owner: "a", state: "saved", kind: "forward", waybill: "", record: { bookingStatus: "BOOKED_AWB_PENDING", waybill: "AWB-2" }, createdAt: new Date("2026-09-01T12:30:00Z") },
    { _id: "draft", owner: "a", state: "draft", kind: "forward", record: { bookingStatus: "BOOKED_AWB_PENDING" }, createdAt: new Date("2026-09-01T13:00:00Z") },
    { _id: "creating", owner: "a", state: "creating", kind: "forward", record: { bookingStatus: "BOOKED_AWB_PENDING" }, createdAt: new Date("2026-09-01T14:00:00Z") },
    { _id: "reverse", owner: "a", state: "saved", kind: "reverse", record: { bookingStatus: "BOOKED_AWB_PENDING" }, createdAt: new Date("2026-09-01T15:00:00Z") },
    { _id: "other-owner", owner: "b", state: "saved", kind: "forward", record: { bookingStatus: "BOOKED_AWB_PENDING" }, createdAt: new Date("2026-09-01T16:00:00Z") },
    { _id: "ordinary-saved", owner: "a", state: "saved", kind: "forward", record: { status: "Pending pickup" }, createdAt: new Date("2026-09-01T17:00:00Z") },
    { _id: "next-day", owner: "a", state: "saved", kind: "forward", record: { bookingStatus: "BOOKED_AWB_PENDING" }, createdAt: new Date("2026-09-02T00:00:00Z") },
  ]);
  const result = await getDashboardOverview({ Shipment, PickupRequest: model([]), NdrCase: model([]), RtoRecord: model([]) }, "a", {
    from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-02T00:00:00Z"),
  });
  assert.equal(result.metrics.pendingAwbShipments, 4);
});

test("dashboard includes eligible but unmaterialized NDR and mapped RTO events without writing cases", async () => {
  const shipment = { _id: "s1", owner: "owner", state: "saved", waybill: "MOCK-AWB", reference: "MOCK-REF", record: { partnerCode: "MOCK" }, trackingStatus: "RTO In Transit", createdAt: new Date("2026-09-01"), trackingEvents: [
    { eventKey: "ndr-event", providerCode: "MOCK", status: "Undelivered", description: "Consignee unavailable", occurredAt: new Date("2026-09-01T10:00:00Z") },
    { eventKey: "rto-event", providerCode: "MOCK", status: "RTO In Transit", description: "Return initiated", occurredAt: new Date("2026-09-01T11:00:00Z") },
  ] };
  const cases = { ndr: [], rto: [] };
  const Shipment = model([shipment]);
  const NdrCase = model(cases.ndr);
  const RtoRecord = model(cases.rto);
  const result = await getDashboardOverview({ Shipment, NdrCase, RtoRecord, PickupRequest: model([]) }, "owner", { statusMappings: mappings });
  assert.equal(result.metrics.ndrShipments, 1);
  assert.equal(result.metrics.unresolvedNdrCases, 1);
  assert.equal(result.metrics.rtoShipments, 1);
  assert.equal(result.metrics.activeRtoCases, 1);
  assert.deepEqual(cases, { ndr: [], rto: [] });
});

test("dashboard NDR and RTO metrics count affected shipments once across persisted and derived events", async () => {
  const shipment = { _id: "shipment-1", owner: "owner-a", state: "saved", kind: "forward", waybill: "AWB-1", record: { partnerCode: "MOCK" }, trackingStatus: "In Transit", createdAt: new Date("2026-09-01"), trackingEvents: [
    { eventKey: "ndr-1", providerCode: "MOCK", status: "Undelivered", description: "Consignee unavailable", occurredAt: new Date("2026-09-01T10:00:00Z") },
    { eventKey: "ndr-2", providerCode: "MOCK", status: "Delivery attempted", occurredAt: new Date("2026-09-01T11:00:00Z") },
    { eventKey: "rto-1", providerCode: "MOCK", status: "RTO In Transit", description: "Return started", occurredAt: new Date("2026-09-01T12:00:00Z") },
    { eventKey: "rto-2", providerCode: "MOCK", status: "RTO In Transit", description: "Return update", occurredAt: new Date("2026-09-01T13:00:00Z") },
  ] };
  const shipments = model([shipment, { ...shipment, _id: "other-owner", owner: "owner-b" }]);
  const ndrCases = model([
    { _id: "n1", owner: "owner-a", shipment: "shipment-1", trackingEventKey: "ndr-1", waybill: "AWB-1", status: "OPEN", occurredAt: new Date("2026-09-01T10:00:00Z") },
  ]);
  const rtoCases = model([
    { _id: "r1", owner: "owner-a", originalShipment: "shipment-1", triggerEventKey: "rto-1", originalWaybill: "AWB-1", status: "RTO In Transit", lifecycleState: "ACTIVE", occurredAt: new Date("2026-09-01T12:00:00Z") },
  ]);
  const result = await getDashboardOverview({ Shipment: shipments, NdrCase: ndrCases, RtoRecord: rtoCases, PickupRequest: model([]) }, "owner-a", { statusMappings: mappings });
  assert.equal(result.metrics.ndrShipments, 1);
  assert.equal(result.metrics.rtoShipments, 1);
});

test("dashboard case detail builders apply event date and canonical shipment status filters", () => {
  const { buildDashboardNdrCases, buildDashboardRtoCases, groupNdrShipments, groupRtoShipments } = require("./dashboardService");
  const shipment = { _id: "s1", owner: "a", kind: "forward", waybill: "AWB-1", record: { partnerCode: "MOCK" }, trackingStatus: "In Transit", trackingEvents: [
    { eventKey: "n1", providerCode: "MOCK", status: "Undelivered", description: "Consignee unavailable", occurredAt: new Date("2026-09-01T10:00:00Z") },
    { eventKey: "n2", providerCode: "MOCK", status: "Delivery attempted", occurredAt: new Date("2026-09-02T10:00:00Z") },
    { eventKey: "r1", providerCode: "MOCK", status: "RTO In Transit", occurredAt: new Date("2026-09-01T11:00:00Z") },
    { eventKey: "r2", providerCode: "MOCK", status: "RTO In Transit", occurredAt: new Date("2026-09-02T11:00:00Z") },
  ] };
  const filters = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-02T00:00:00Z"), status: "inTransit", statusMappings: mappings };
  const ndr = buildDashboardNdrCases([shipment], [], filters);
  const rto = buildDashboardRtoCases([shipment], [], filters);
  assert.equal(groupNdrShipments(ndr).length, 1);
  assert.equal(groupNdrShipments(ndr)[0].cases.length, 1);
  assert.equal(groupRtoShipments(rto).length, 1);
  assert.equal(groupRtoShipments(rto)[0].cases.length, 1);
  assert.equal(buildDashboardNdrCases([shipment], [], { ...filters, status: "delivered" }).length, 0);
});
