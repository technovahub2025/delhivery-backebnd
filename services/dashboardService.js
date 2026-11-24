const { mapProviderStatus } = require("./providerStatusMappings");
const { collectNdrObservations } = require("./ndrService");
const { collectRtoObservations } = require("./rtoService");

function canonicalShipmentStatus(row, statusMappings) {
  const raw = row.trackingStatus || row.record?.status || "";
  const provider = row.record?.partnerCode || row.record?.carrierCode || row.record?.providerCode || row.trackingEvents?.at(-1)?.providerCode || "";
  return mapProviderStatus(provider, "shipment", raw, statusMappings) ||
    (!row.trackingStatus && /^pending pickup$/i.test(raw) ? "PICKUP_PENDING" : null);
}

function shipmentGroup(row, statusMappings = {}) {
  const status = canonicalShipmentStatus(row, statusMappings);
  return ({ IN_TRANSIT: "inTransit", DELIVERED: "delivered", FAILED: "failedException",
    EXCEPTION: "failedException", OUT_FOR_DELIVERY: "outForDelivery", PICKUP_PENDING: "pickupPending" })[status] || "unknown";
}

function shipmentDashboardTags(row, statusMappings = {}) {
  const status = canonicalShipmentStatus(row, statusMappings);
  return [
    ...(status && status !== "DELIVERED" ? ["undelivered"] : []),
    ...(status === "OUT_FOR_DELIVERY" ? ["outForDelivery"] : []),
    ...(status === "PICKUP_PENDING" ? ["pickupPending"] : []),
    ...(["EXCEPTION", "DELAYED", "LOST", "DAMAGED"].includes(status) ? ["transitException"] : []),
  ];
}

function inRange(value, from, to) {
  if (!value) return !from && !to;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  if (from && date < from) return false;
  if (to && date >= to) return false;
  return true;
}

function dateFilter(from, to, field) {
  const filter = {};
  if (from || to) filter[field] = { ...(from && { $gte: from }), ...(to && { $lt: to }) };
  return filter;
}

function parseDashboardCaseFilters(query = {}, allowedTargets = []) {
  const parse = (value, end = false) => {
    if (!value) return null;
    const text = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new TypeError("Date filters must use YYYY-MM-DD.");
    const date = new Date(`${text}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new TypeError("Date filters must use valid calendar dates.");
    if (end) date.setUTCDate(date.getUTCDate() + 1);
    return date;
  };
  const from = parse(query.from);
  const to = parse(query.to, true);
  if (from && to && from >= to) throw new TypeError("The end date must be on or after the start date.");
  const status = String(query.status || "").trim();
  const allowedStatuses = new Set(["inTransit", "delivered", "failedException", "unknown", "rtoInTransit", "other"]);
  if (status && !allowedStatuses.has(status)) throw new TypeError("Unsupported shipment status filter.");
  const target = String(query.target || "").trim();
  if (target && !allowedTargets.includes(target)) throw new TypeError("Unsupported dashboard target.");
  return { from, to, status: status || "", target };
}

async function rows(model, filter) {
  if (!model) return [];
  let query = model.find(filter);
  if (query?.lean) query = query.lean();
  return await query;
}

function idOf(value) { return String(value?._id ?? value ?? ""); }
function providerOf(row) { return String(row.providerCode || row.record?.partnerCode || row.record?.carrierCode || row.trackingEvents?.at(-1)?.providerCode || "").toUpperCase(); }
function hasCanonicalMapping(providers, domain, canonical, mappings) {
  return providers.length === 0 || providers.every(provider => Object.values(mappings?.[provider]?.[domain] || {}).includes(canonical));
}
function hasRtoConfiguration(providers, mappings) {
  return (providers.length === 0 || providers.every(provider => Object.values(mappings?.[provider]?.rtoTrigger || {}).includes("RTO_TRIGGER"))) &&
    ["ACTIVE", "COMPLETED", "UNRESOLVED"].every(state => hasCanonicalMapping(providers, "rto", state, mappings));
}

function mergeCaseSnapshots(stored, derived, keyOf, defaultStatus) {
  const map = new Map();
  for (const row of stored) map.set(keyOf(row), row);
  for (const row of derived) {
    const key = keyOf(row);
    if (!map.has(key)) map.set(key, { ...row, status: defaultStatus });
  }
  return [...map.values()];
}

function selectedForwardShipmentIds(shipments, status, statusMappings) {
  return new Set(shipments
    .filter(row => row.kind === "forward" || row.kind == null)
    .filter(row => !status || shipmentGroup(row, statusMappings) === status)
    .map(row => idOf(row)));
}

function buildDashboardNdrCases(shipments, storedRows, { from, to, status, statusMappings = {} } = {}) {
  const forward = shipments.filter(row => row.kind === "forward" || row.kind == null);
  const selectedIds = selectedForwardShipmentIds(forward, status, statusMappings);
  const stored = storedRows.filter(row => inRange(row.occurredAt, from, to));
  const derived = forward.flatMap(shipment => collectNdrObservations(shipment, shipment.trackingEvents || [])
    .filter(item => inRange(item.occurredAt, from, to)));
  return mergeCaseSnapshots(stored, derived, row => `${idOf(row.shipment)}:${row.trackingEventKey}`, "OPEN")
    .filter(row => selectedIds.has(idOf(row.shipment)));
}

function buildDashboardRtoCases(shipments, storedRows, { from, to, status, statusMappings = {} } = {}) {
  const forward = shipments.filter(row => row.kind === "forward" || row.kind == null);
  const selectedIds = selectedForwardShipmentIds(forward, status, statusMappings);
  const stored = storedRows.filter(row => inRange(row.occurredAt, from, to));
  const derived = forward.flatMap(shipment => collectRtoObservations(shipment, shipment.trackingEvents || [], statusMappings)
    .filter(item => inRange(item.occurredAt, from, to)));
  return mergeCaseSnapshots(stored, derived, row => `${idOf(row.originalShipment)}:${row.triggerEventKey}`, "UNRESOLVED")
    .filter(row => selectedIds.has(idOf(row.originalShipment)));
}

function groupNdrShipments(cases) {
  const groups = new Map();
  for (const item of cases) {
    const shipmentId = idOf(item.shipment);
    if (!shipmentId) continue;
    if (!groups.has(shipmentId)) groups.set(shipmentId, {
      shipmentId, waybill: item.waybill || "", reference: item.reference || "",
      customer: item.customer || "", destination: item.destination || "", payment: item.payment || "",
      occurredAt: item.occurredAt || null, cases: [],
    });
    const group = groups.get(shipmentId);
    group.cases.push(item);
    if (new Date(item.occurredAt || 0) > new Date(group.occurredAt || 0)) group.occurredAt = item.occurredAt;
  }
  return [...groups.values()].sort((a, b) => new Date(b.occurredAt || 0) - new Date(a.occurredAt || 0));
}

function groupRtoShipments(cases) {
  const groups = new Map();
  for (const item of cases) {
    const shipmentId = idOf(item.originalShipment);
    if (!shipmentId) continue;
    if (!groups.has(shipmentId)) groups.set(shipmentId, {
      shipmentId, originalWaybill: item.originalWaybill || "", originalReference: item.originalReference || "",
      providerCode: item.providerCode || "", occurredAt: item.occurredAt || null, cases: [],
    });
    const group = groups.get(shipmentId);
    group.cases.push(item);
    if (new Date(item.occurredAt || 0) > new Date(group.occurredAt || 0)) group.occurredAt = item.occurredAt;
  }
  return [...groups.values()].sort((a, b) => new Date(b.occurredAt || 0) - new Date(a.occurredAt || 0));
}

async function getDashboardNdrCases({ Shipment, NdrCase }, owner, filters = {}) {
  const [shipments, cases] = await Promise.all([
    rows(Shipment, { owner, state: "saved" }),
    rows(NdrCase, { owner }),
  ]);
  return buildDashboardNdrCases(shipments, cases, filters);
}

async function getDashboardRtoCases({ Shipment, RtoRecord }, owner, filters = {}) {
  const [shipments, cases] = await Promise.all([
    rows(Shipment, { owner, state: "saved" }),
    rows(RtoRecord, { owner }),
  ]);
  return buildDashboardRtoCases(shipments, cases, filters);
}

async function getDashboardOverview({ Shipment, PickupRequest, NdrCase, RtoRecord }, owner, { from, to, status, statusMappings = {} } = {}) {
  const accountRows = await rows(Shipment, { owner, state: { $in: ["saved", "draft", "creating"] } });
  const allShipments = accountRows.filter(row => row.state === "saved");
  // The account shipment endpoint exposes forward shipments only. Use the same
  // population for shipment dashboard metrics so click-throughs have identical
  // eligible rows. Reverse logistics remains represented by its own cases.
  const forwardShipments = allShipments.filter(row => row.kind === "forward" || row.kind == null);
  const shipmentProviders = [...new Set(forwardShipments.map(providerOf).filter(Boolean))];
  const inTransitAvailable = hasCanonicalMapping(shipmentProviders, "shipment", "IN_TRANSIT", statusMappings);
  const deliveredAvailable = hasCanonicalMapping(shipmentProviders, "shipment", "DELIVERED", statusMappings);
  const failedAvailable = hasCanonicalMapping(shipmentProviders, "shipment", "FAILED", statusMappings) && hasCanonicalMapping(shipmentProviders, "shipment", "EXCEPTION", statusMappings);
  const shipmentStatusesAvailable = inTransitAvailable && deliveredAvailable && failedAvailable;
  const groupedAll = forwardShipments.map(row => ({ row, group: shipmentGroup(row, statusMappings) }));
  const grouped = groupedAll.filter(({ row }) => inRange(row.createdAt, from, to));
  const selected = status ? grouped.filter(item => item.group === status) : grouped;
  const pendingAwbShipments = accountRows.filter(row =>
    (row.kind === "forward" || (row.kind == null && row.state === "saved")) &&
    inRange(row.createdAt, from, to) &&
    (row.state === "draft" || row.state === "creating" ||
      (row.record?.bookingStatus === "BOOKED_AWB_PENDING" &&
        !String(row.waybill || "").trim() && !String(row.record?.waybill || "").trim()))
  ).length;
  const selectedIds = new Set(groupedAll.filter(item => !status || item.group === status).map(({ row }) => idOf(row)));

  const allPickups = await rows(PickupRequest, { owner });
  const fromDay = from?.toISOString().slice(0, 10);
  const toDay = to ? new Date(to.getTime() - 1).toISOString().slice(0, 10) : null;
  const pickups = allPickups.filter(row => {
    const day = String(row.pickupDate || "").slice(0, 10);
    return (!fromDay && !toDay) || (!!day && (!fromDay || day >= fromDay) && (!toDay || day <= toDay));
  });

  const storedNdr = await rows(NdrCase, { owner, ...dateFilter(from, to, "occurredAt") });
  const ndrCases = buildDashboardNdrCases(forwardShipments, storedNdr, { from, to, status, statusMappings });
  const ndrShipments = groupNdrShipments(ndrCases);

  const storedRto = await rows(RtoRecord, { owner, ...dateFilter(from, to, "occurredAt") });
  const rtoCases = buildDashboardRtoCases(forwardShipments, storedRto, { from, to, status, statusMappings });
  const rtoShipments = groupRtoShipments(rtoCases);

  const uniqueCaseShipments = records => new Set(records.map(row => idOf(row.shipment ?? row.originalShipment)).filter(Boolean)).size;
  const pickupCounts = {};
  for (const pickup of pickups) pickupCounts[String(pickup.status || "Unknown")] = (pickupCounts[String(pickup.status || "Unknown")] || 0) + 1;
  const counts = Object.fromEntries(["inTransit", "delivered", "failedException", "unknown"].map(key => [key, selected.filter(item => item.group === key).length]));
  const tagged = selected.map(({ row }) => shipmentDashboardTags(row, statusMappings));
  const countTag = group => tagged.filter(tags => tags.includes(group)).length;
  const supportsOutForDelivery = hasCanonicalMapping(shipmentProviders, "shipment", "OUT_FOR_DELIVERY", statusMappings);
  const supportsTransitExceptions = ["EXCEPTION", "DELAYED", "LOST", "DAMAGED"].some(value => hasCanonicalMapping(shipmentProviders, "shipment", value, statusMappings));
  const unresolvedNdr = ndrCases.filter(row => row.status !== "RESOLVED");
  const rtoProviders = [...new Set(rtoCases.map(providerOf).filter(Boolean))];
  const trackedProviderSet = [...new Set(allShipments.filter(row => row.trackingEvents?.length || row.trackingStatus).map(providerOf).filter(Boolean))];
  const rtoLifecycleAvailable = (trackedProviderSet.length === 0 && rtoCases.length === 0) || hasRtoConfiguration(rtoProviders.length ? rtoProviders : trackedProviderSet, statusMappings);
  const rtoLifecycleCounts = {
    active: rtoCases.filter(row => row.lifecycleState === "ACTIVE").length,
    completed: rtoCases.filter(row => row.lifecycleState === "COMPLETED").length,
    unresolved: rtoCases.filter(row => !["ACTIVE", "COMPLETED"].includes(row.lifecycleState || "UNRESOLVED")).length,
  };

  const recentActivity = [];
  for (const row of allShipments.filter(item => selectedIds.has(idOf(item)))) {
    if (row.createdAt && inRange(row.createdAt, from, to)) recentActivity.push({ id: `shipment:${idOf(row)}:created`, type: "shipment", shipmentId: idOf(row), reference: row.reference || "", waybill: row.waybill || "", status: "Shipment created", timestamp: row.createdAt, description: "Shipment saved in this workspace." });
    for (const event of row.trackingEvents || []) recentActivity.push({ id: `tracking:${idOf(row)}:${event.eventKey || event.occurredAt}`, type: "tracking", shipmentId: idOf(row), reference: row.reference || "", waybill: row.waybill || "", status: event.status || "", location: event.location || "", timestamp: event.occurredAt || null, description: event.description || "" });
  }
  for (const pickup of pickups) for (const event of pickup.history || []) recentActivity.push({ id: `pickup:${idOf(pickup)}:${event.timestamp}:${event.action}`, type: "pickup", pickupId: idOf(pickup), status: event.status || "", timestamp: event.timestamp || null, description: event.description || event.action || "" });
  for (const item of ndrCases) recentActivity.push({ id: `ndr:${idOf(item)}:${item.trackingEventKey || item.occurredAt}`, type: "ndr", shipmentId: idOf(item.shipment), status: `NDR ${item.status}`, timestamp: item.occurredAt, description: item.reason || "" });
  for (const item of rtoCases) recentActivity.push({ id: `rto:${idOf(item)}:${item.triggerEventKey || item.occurredAt}`, type: "rto", shipmentId: idOf(item.originalShipment), status: `${item.lifecycleState || "UNRESOLVED"} · ${item.status}`, timestamp: item.occurredAt, description: item.reason || "" });
  const activity = recentActivity.filter(item => inRange(item.timestamp, from, to)).sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)).slice(0, 20);

  const statusFilterAvailable = !status || (status === "inTransit" ? inTransitAvailable : status === "delivered" ? deliveredAvailable : status === "failedException" ? failedAvailable : shipmentStatusesAvailable);
  return {
    filters: { from: from?.toISOString() || null, to: to?.toISOString() || null, status: status || null },
    metrics: {
      totalShipments: statusFilterAvailable ? selected.length : null,
      pendingAwbShipments,
      pendingPickups: pickups.filter(row => row.status === "Pending").length,
      pickupPendingShipments: countTag("pickupPending"),
      undeliveredShipments: countTag("undelivered"),
      outForDeliveryShipments: supportsOutForDelivery ? countTag("outForDelivery") : null,
      transitExceptionShipments: supportsTransitExceptions ? countTag("transitException") : null,
      inTransitShipments: inTransitAvailable ? counts.inTransit : null,
      deliveredShipments: deliveredAvailable ? counts.delivered : null,
      ndrShipments: statusFilterAvailable ? ndrShipments.length : null,
      unresolvedNdrCases: statusFilterAvailable ? unresolvedNdr.length : null,
      rtoShipments: statusFilterAvailable ? rtoShipments.length : null,
      activeRtoCases: rtoLifecycleAvailable ? rtoLifecycleCounts.active : null,
      completedRtoCases: rtoLifecycleAvailable ? rtoLifecycleCounts.completed : null,
      unresolvedRtoCases: rtoLifecycleAvailable ? rtoLifecycleCounts.unresolved : null,
      failedExceptionShipments: failedAvailable ? counts.failedException : null,
    },
    availability: {
      shipmentStatusMetrics: { available: shipmentStatusesAvailable, inTransitAvailable, deliveredAvailable, failedExceptionAvailable: failedAvailable, reason: shipmentStatusesAvailable ? "Provider status mappings cover each displayed shipment status group." : "Provider-specific mappings for IN_TRANSIT, DELIVERED, FAILED and EXCEPTION are required." },
      rtoLifecycleMetrics: { available: rtoLifecycleAvailable, reason: rtoLifecycleAvailable ? "RTO lifecycle status mappings are configured." : "Provider-specific RTO lifecycle mappings are required." },
    },
    pickupSummary: { total: pickups.length, byStatus: pickupCounts },
    deliverySummary: { inTransit: inTransitAvailable ? counts.inTransit : null, delivered: deliveredAvailable ? counts.delivered : null, failedOrException: failedAvailable ? counts.failedException : null, unclassified: counts.unknown },
    recentActivity: activity,
  };
}

module.exports = { shipmentGroup, shipmentDashboardTags, parseDashboardCaseFilters, buildDashboardNdrCases, buildDashboardRtoCases, groupNdrShipments, groupRtoShipments, getDashboardNdrCases, getDashboardRtoCases, getDashboardOverview };
