const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 60;
const MAX_PAGE = 100;
const SOURCES = ["shipments", "customers", "addresses", "pickups", "ndr", "rto"];
const SOURCE_PERMISSIONS = ["shipments.read", "customers.read", "party_addresses.read", "pickup_requests.read", "ndr.read", "rto.read"];

function parseSearch(value) {
  const term = String(value ?? "").trim();
  if (term.length < 2 || term.length > 100) {
    const error = new Error("Enter a search term between 2 and 100 characters.");
    error.status = 400;
    throw error;
  }
  const digits = term.replace(/\D/g, "");
  if (/^[0-9]{6}$/.test(term)) return { kind: "pincode", term };
  if (/^[+() .-]*[0-9][0-9+() .-]*$/.test(term) && digits.length >= 10 && digits.length <= 15) {
    const national = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
    const formatted = national.split("").join("[\\s().-]*");
    return { kind: "phone", term, phone: new RegExp(`^(?:\\+?91[\\s().-]*)?${formatted}$`) };
  }
  if (/^[0-9]+$/.test(term) && term.length < 6) {
    const error = new Error("Enter a complete 10–15 digit mobile number or a valid six-digit pincode.");
    error.status = 400;
    throw error;
  }
  if (!/[a-z0-9]/i.test(term)) {
    const error = new Error("Search must contain at least one letter or number.");
    error.status = 400;
    throw error;
  }
  return { kind: "text", term, prefix: { $gte: term, $lt: `${term}\uffff` } };
}

function sourceFilters(search) {
  if (search.kind === "pincode") return [
    { owner: null, $or: [{ "record.pin": search.term }, { "record.pincode": search.term }] },
    null,
    { owner: null, pincode: search.term },
    { owner: null, "location.pincode": search.term },
    null,
    null,
  ];
  if (search.kind === "phone") return [
    { owner: null, "record.phone": search.phone },
    { owner: null, "primaryContact.phone": search.phone },
    { owner: null, phone: search.phone },
    { owner: null, "location.phone": search.phone },
    null,
    null,
  ];
  const text = search.prefix;
  return [
    { owner: null, $or: [{ waybill: text }, { reference: text }, { "record.name": text }, { "record.customer": text }] },
    { owner: null, $or: [{ displayName: text }, { companyName: text }, { "primaryContact.name": text }] },
    { owner: null, $or: [{ companyName: text }, { contactName: text }] },
    { owner: null, $or: [{ carrierRequestId: text }, { warehouse: text }, { "shipmentRefs.waybill": text }, { "shipmentRefs.reference": text }] },
    { owner: null, $or: [{ waybill: text }, { reference: text }, { customer: text }] },
    { owner: null, $or: [{ originalWaybill: text }, { originalReference: text }] },
  ];
}

function displayName(row, fallback) {
  return row.displayName || row.companyName || row.customer || row.record?.name || fallback;
}

function publicResult(type, row) {
  const id = String(row._id);
  const result = { id, type, label: "", detail: "", target: "" };
  if (type === "SHIPMENT") Object.assign(result, { label: row.waybill || row.reference || "Shipment", detail: displayName(row.record || {}, "Shipment"), target: "shipments", searchTerm: row.waybill || row.reference || "", shipmentId: id });
  if (type === "CUSTOMER") Object.assign(result, { label: displayName(row, "Customer"), detail: row.primaryContact?.phone || "Customer", target: "customers", searchTerm: displayName(row, "") });
  if (type === "ADDRESS") Object.assign(result, { label: displayName(row, "Saved address"), detail: [row.contactName, row.phone, row.pincode].filter(Boolean).join(" · "), target: "partyAddresses", searchTerm: row.pincode || row.phone || row.contactName || row.companyName || "" });
  if (type === "PICKUP") Object.assign(result, { label: row.carrierRequestId || `Pickup ${id.slice(-6)}`, detail: row.warehouse || "Pickup request", target: "pickups", searchTerm: row.carrierRequestId || "" });
  if (type === "NDR") Object.assign(result, { label: row.waybill, detail: `${row.customer || "NDR case"} · ${row.status}`, target: "ndr", searchTerm: row.waybill || row.reference || "" });
  if (type === "RTO") Object.assign(result, { label: row.originalWaybill, detail: `${row.status} · ${row.lifecycleState}`, target: "rto", searchTerm: row.originalWaybill || row.originalReference || "" });
  return result;
}

async function readQuery(query) { return query && typeof query.lean === "function" ? query.lean() : query; }

async function operationalSearch({ owner, q, page = 1, limit = DEFAULT_LIMIT, models, permissions }) {
  if (typeof owner !== "string" || !owner) { const error = new Error("Login required."); error.status = 401; throw error; }
  const search = parseSearch(q);
  const requestedPage = Number(page);
  const requestedLimit = Number(limit);
  if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > MAX_PAGE || !Number.isInteger(requestedLimit) || requestedLimit < 6 || requestedLimit > MAX_LIMIT) {
    const error = new Error(`Page must be 1–${MAX_PAGE}; limit must be 6–${MAX_LIMIT}.`);
    error.status = 400;
    throw error;
  }
  const filters = sourceFilters(search).map((filter, index) =>
    filter && (!permissions || permissions.includes(SOURCE_PERMISSIONS[index])) ? { ...filter, owner } : null);
  const modelList = [models.Shipment, models.Customer, models.Address, models.Pickup, models.Ndr, models.Rto];
  const resultTypes = ["SHIPMENT", "CUSTOMER", "ADDRESS", "PICKUP", "NDR", "RTO"];
  const counts = await Promise.all(modelList.map(async (Model, index) => {
    if (!filters[index] || !Model?.countDocuments) return 0;
    let countQuery = Model.countDocuments(filters[index]);
    if (search.kind === "text" && typeof countQuery?.collation === "function") countQuery = countQuery.collation({ locale: "en", strength: 2 });
    return Number(await countQuery || 0);
  }));
  const quotas = Array(SOURCES.length).fill(0);
  let remaining = requestedLimit;
  const active = counts.map((count, index) => count > 0 ? index : -1).filter(index => index >= 0);
  for (const index of active) {
    const quota = Math.min(Number(counts[index]), Math.max(1, Math.floor(requestedLimit / Math.max(1, active.length))));
    quotas[index] = quota;
    remaining -= quota;
  }
  for (const index of active) {
    if (remaining <= 0) break;
    const extra = Math.min(remaining, Number(counts[index]) - quotas[index]);
    quotas[index] += extra;
    remaining -= extra;
  }
  const pages = await Promise.all(modelList.map(async (Model, index) => {
    const filter = filters[index];
    const quota = quotas[index];
    if (!filter || !Model?.find || quota === 0) return [];
    let query = Model.find(filter);
    if (typeof query.sort === "function") query = query.sort({ createdAt: -1, _id: -1 });
    if (search.kind === "text" && typeof query.collation === "function") query = query.collation({ locale: "en", strength: 2 });
    if (typeof query.skip === "function") query = query.skip((requestedPage - 1) * quota);
    if (typeof query.limit === "function") query = query.limit(quota);
    const rows = await readQuery(query);
    return (rows || []).map(row => publicResult(resultTypes[index], row));
  }));
  const total = counts.reduce((sum, count) => sum + Number(count || 0), 0);
  const totalPages = Math.max(...counts.map((count, index) => quotas[index] > 0 ? Math.ceil(count / quotas[index]) : 0), 0);
  return { items: pages.flat(), total, page: requestedPage, limit: requestedLimit, totalPages };
}

module.exports = { operationalSearch, parseSearch, sourceFilters, DEFAULT_LIMIT, MAX_LIMIT, MAX_PAGE };
