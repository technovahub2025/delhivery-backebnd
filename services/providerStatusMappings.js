const DOMAINS = Object.freeze({
  shipment: new Set(["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED", "EXCEPTION", "DELAYED", "LOST", "DAMAGED", "PICKUP_PENDING", "PICKED_UP", "NDR", "RTO"]),
  pickup: new Set(["SCHEDULED", "ASSIGNED", "PICKED_UP", "RESCHEDULED", "COMPLETED", "CANCELLED", "FAILED"]),
  rto: new Set(["ACTIVE", "COMPLETED", "UNRESOLVED"]),
  rtoTrigger: new Set(["RTO_TRIGGER"]),
});

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function validateMappings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Courier status mappings must be a JSON object keyed by provider code.");
  const result = {};
  for (const [provider, domains] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(provider) || !domains || typeof domains !== "object" || Array.isArray(domains)) throw new TypeError("Each courier mapping requires a valid provider code and mapping object.");
    result[provider.toUpperCase()] = {};
    for (const [domain, statuses] of Object.entries(domains)) {
      if (!DOMAINS[domain] || !statuses || typeof statuses !== "object" || Array.isArray(statuses)) throw new TypeError(`Unsupported courier status mapping domain: ${domain}.`);
      const mapped = {};
      for (const [raw, canonical] of Object.entries(statuses)) {
        const valueText = String(canonical || "").trim().toUpperCase();
        if (!raw.trim() || !DOMAINS[domain].has(valueText)) throw new TypeError(`Invalid ${domain} mapping value for provider ${provider}.`);
        mapped[normalizeStatus(raw)] = valueText;
      }
      result[provider.toUpperCase()][domain] = Object.freeze(mapped);
    }
  }
  return Object.freeze(Object.fromEntries(Object.entries(result).map(([provider, domains]) => [provider, Object.freeze(domains)])));
}

function loadStatusMappings(raw = process.env.COURIER_STATUS_MAPPINGS_JSON) {
  if (!raw) return Object.freeze({});
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("COURIER_STATUS_MAPPINGS_JSON must contain valid JSON."); }
  return validateMappings(parsed);
}

function mapProviderStatus(providerCode, domain, rawStatus, mappings = {}) {
  const provider = String(providerCode || "").trim().toUpperCase();
  const key = normalizeStatus(rawStatus);
  return mappings?.[provider]?.[domain]?.[key] || null;
}

module.exports = { DOMAINS, normalizeStatus, validateMappings, loadStatusMappings, mapProviderStatus };
