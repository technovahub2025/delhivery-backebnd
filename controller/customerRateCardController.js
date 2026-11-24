const mongoose = require("mongoose");
const CustomerRateCard = require("../model/customerRateCard");
const Customer = require("../model/customer");
const AppShipment = require("../model/appShipment");
const { resolveCustomerCard, buildPricingSnapshot } = require("../services/customerPricingService");

const SCOPES = new Set(["CUSTOMER", "WALK_IN_STANDARD"]);
const MODES = new Set(["SURFACE", "EXPRESS"]);
const SURCHARGE_KINDS = new Set(["FUEL", "COD", "OTHER"]);
const FIELDS = new Set(["scope", "customerId", "name", "currency", "effectiveFrom", "effectiveTo", "zoneRates", "surcharges", "gstRules"]);
const QUERY_FIELDS = new Set(["scope", "customerId", "search", "page", "limit"]);

class InputError extends Error {}
function isObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function onlyFields(value, allowed, label) {
  if (!isObject(value)) throw new InputError(`${label} must be an object.`);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new InputError(`${label} contains unsupported fields.`);
}
function cleanString(value, field, max, { pattern } = {}) {
  if (typeof value !== "string") throw new InputError(`${field} must be a string.`);
  const result = value.trim();
  if (result.length > max || (result && pattern && !pattern.test(result))) throw new InputError(`${field} is invalid.`);
  return result;
}
function cleanAmount(value, field) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string" || text.length > 40 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    throw new InputError(`${field} must be a non-negative decimal amount.`);
  }
  return text;
}
function cleanDate(value, field) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value)) {
    throw new InputError(`${field} must be an ISO date or UTC timestamp.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new InputError(`${field} must be a valid date.`);
  return date;
}
function cleanWeight(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new InputError(`${field} must be a non-negative number.`);
  return value;
}
function escapeRegex(value) {
  const slash = String.fromCharCode(92);
  const special = "^$.*+?()[]{}|" + slash;
  return Array.from(value, character => special.includes(character) ? slash + character : character).join("");
}

function validateInput(body, { partial = false } = {}) {
  onlyFields(body, FIELDS, "Rate card");
  if (partial && !Object.keys(body).length) throw new InputError("At least one rate card field is required.");
  if (!partial && !Object.hasOwn(body, "scope")) throw new InputError("scope is required.");
  const data = {};
  if (Object.hasOwn(body, "scope")) {
    if (!SCOPES.has(body.scope)) throw new InputError("scope must be CUSTOMER or WALK_IN_STANDARD.");
    data.scope = body.scope;
  }
  if (Object.hasOwn(body, "customerId")) {
    if (body.customerId === null || body.customerId === "") data.customerId = null;
    else if (typeof body.customerId !== "string" || !mongoose.isValidObjectId(body.customerId)) throw new InputError("customerId must be a valid MongoDB ObjectId or null.");
    else data.customerId = body.customerId;
  }
  if (Object.hasOwn(body, "name")) data.name = cleanString(body.name, "name", 200);
  if (Object.hasOwn(body, "currency")) data.currency = cleanString(body.currency, "currency", 3, { pattern: /^[A-Za-z]{3}$/ }).toUpperCase();
  for (const field of ["effectiveFrom", "effectiveTo"]) if (Object.hasOwn(body, field)) data[field] = cleanDate(body[field], field);
  if (Object.hasOwn(body, "zoneRates")) {
    if (!Array.isArray(body.zoneRates) || !body.zoneRates.length || body.zoneRates.length > 500) throw new InputError("zoneRates must contain between 1 and 500 zones.");
    data.zoneRates = body.zoneRates.map((zone, zi) => {
      onlyFields(zone, new Set(["zone", "modes"]), `zoneRates[${zi}]`);
      const zoneName = cleanString(zone.zone, `zoneRates[${zi}].zone`, 100);
      if (!zoneName) throw new InputError(`zoneRates[${zi}].zone is required.`);
      if (!Array.isArray(zone.modes) || !zone.modes.length || zone.modes.length > 2) throw new InputError(`zoneRates[${zi}].modes must contain at least one mode.`);
      return { zone: zoneName, modes: zone.modes.map((mode, mi) => {
        onlyFields(mode, new Set(["mode", "weightSlabs"]), `zoneRates[${zi}].modes[${mi}]`);
        if (!MODES.has(mode.mode)) throw new InputError("mode must be SURFACE or EXPRESS.");
        if (!Array.isArray(mode.weightSlabs) || !mode.weightSlabs.length || mode.weightSlabs.length > 500) throw new InputError("Each mode must contain at least one weight slab.");
        return { mode: mode.mode, weightSlabs: mode.weightSlabs.map((slab, si) => {
          onlyFields(slab, new Set(["minWeight", "maxWeight", "baseRate", "additionalWeightCharge", "includedWeight", "additionalWeightIncrement"]), `weightSlabs[${si}]`);
          const minWeight = cleanWeight(slab.minWeight, "minWeight");
          const maxWeight = cleanWeight(slab.maxWeight, "maxWeight");
          if (maxWeight <= minWeight) throw new InputError("maxWeight must be greater than minWeight.");
          const result = { minWeight, maxWeight, baseRate: cleanAmount(slab.baseRate, "baseRate") };
          if (Object.hasOwn(slab, "additionalWeightCharge")) result.additionalWeightCharge = cleanAmount(slab.additionalWeightCharge, "additionalWeightCharge");
          if (Object.hasOwn(slab, "includedWeight")) {
            result.includedWeight = cleanWeight(slab.includedWeight, "includedWeight");
            if (result.includedWeight > maxWeight) throw new InputError("includedWeight cannot exceed maxWeight.");
          }
          if (Object.hasOwn(slab, "additionalWeightIncrement")) {
            result.additionalWeightIncrement = cleanWeight(slab.additionalWeightIncrement, "additionalWeightIncrement");
            if (!result.additionalWeightIncrement) throw new InputError("additionalWeightIncrement must be positive.");
          }
          return result;
        }) };
      }) };
    });
  }
  if (Object.hasOwn(body, "surcharges")) {
    if (!Array.isArray(body.surcharges) || body.surcharges.length > 100) throw new InputError("surcharges must be an array of at most 100 rules.");
    data.surcharges = body.surcharges.map((rule, index) => {
      onlyFields(rule, new Set(["kind", "label", "calculationType", "basis", "value"]), `surcharges[${index}]`);
      if (!SURCHARGE_KINDS.has(rule.kind)) throw new InputError("Surcharge kind must be FUEL, COD, or OTHER.");
      const output = { kind: rule.kind, value: cleanAmount(rule.value, "surcharge value") };
      for (const field of ["label", "calculationType", "basis"]) if (Object.hasOwn(rule, field)) output[field] = cleanString(rule[field], field, field === "label" ? 120 : 80);
      return output;
    });
  }
  if (Object.hasOwn(body, "gstRules")) {
    if (!Array.isArray(body.gstRules) || body.gstRules.length > 100) throw new InputError("gstRules must be an array of at most 100 rules.");
    data.gstRules = body.gstRules.map((rule, index) => {
      onlyFields(rule, new Set(["name", "rate", "inclusive"]), `gstRules[${index}]`);
      const output = { rate: cleanAmount(rule.rate, "GST rate") };
      if (Object.hasOwn(rule, "name")) output.name = cleanString(rule.name, "GST rule name", 120);
      if (Object.hasOwn(rule, "inclusive")) {
        if (typeof rule.inclusive !== "boolean") throw new InputError("GST inclusive must be a boolean.");
        output.inclusive = rule.inclusive;
      }
      return output;
    });
  }
  const scope = data.scope;
  const customerId = data.customerId;
  if (scope === "CUSTOMER" && customerId === null) throw new InputError("CUSTOMER cards require customerId.");
  if (scope === "WALK_IN_STANDARD" && customerId != null) throw new InputError("WALK_IN_STANDARD cards must not reference a customer.");
  if (!partial && scope === "CUSTOMER" && customerId === undefined) throw new InputError("CUSTOMER cards require customerId.");
  if (!partial && scope === "WALK_IN_STANDARD" && customerId !== undefined) throw new InputError("WALK_IN_STANDARD cards must not reference a customer.");
  if (!partial && !Object.hasOwn(body, "zoneRates")) throw new InputError("zoneRates is required.");
  if (data.effectiveFrom && data.effectiveTo && data.effectiveTo < data.effectiveFrom) throw new InputError("effectiveTo must be on or after effectiveFrom.");
  return data;
}

function jsonValue(value) {
  if (value == null) return value;
  if (typeof value.toString === "function" && value._bsontype === "Decimal128") return value.toString();
  if (value._bsontype === "ObjectId") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_id" && key !== "__v").map(([key, child]) => [key, jsonValue(child)]));
  return value;
}
function cardData(card) {
  const value = typeof card.toObject === "function" ? card.toObject() : card;
  const data = jsonValue(value);
  data.id = String(value._id);
  delete data._id; delete data.owner;
  return data;
}
function isValidationError(error) { return error?.name === "ValidationError" || error?.name === "CastError" || error?.code === "BSONError"; }

function createCustomerRateCardController({ RateCardModel = CustomerRateCard, CustomerModel = Customer, ShipmentModel = AppShipment } = {}) {
  async function validateCustomer(customerId, owner) {
    const customer = await CustomerModel.findOne({ _id: customerId, owner }).select("_id category").lean();
    if (!customer) return false;
    return customer.category === "CREDIT";
  }
  async function list(req, res) {
    const query = req.query;
    if (Object.keys(query).some(key => !QUERY_FIELDS.has(key)) || (query.scope && !SCOPES.has(query.scope)) || (query.customerId && !mongoose.isValidObjectId(query.customerId))) {
      return res.status(400).json({ success: false, message: "Invalid rate card filter." });
    }
    if (query.search !== undefined && (typeof query.search !== "string" || query.search.trim().length > 200)) return res.status(400).json({ success: false, message: "search must be 200 characters or fewer." });
    const pageText = query.page ?? "1"; const limitText = query.limit ?? "100";
    if (!/^[1-9]\d*$/.test(pageText) || !/^[1-9]\d*$/.test(limitText) || Number(limitText) > 100) return res.status(400).json({ success: false, message: "page must be positive and limit must be between 1 and 100." });
    try {
      if (query.customerId && !await CustomerModel.findOne({ _id: query.customerId, owner: req.user.id }).select("_id").lean()) return res.status(404).json({ success: false, message: "Customer not found." });
      const filter = { owner: req.user.id };
      if (query.scope) filter.scope = query.scope;
      if (query.customerId) filter.customerId = query.customerId;
      if (query.search?.trim()) filter.name = new RegExp(escapeRegex(query.search.trim()), "i");
      const page = Number(pageText); const limit = Number(limitText);
      const [total, cards] = await Promise.all([RateCardModel.countDocuments(filter), RateCardModel.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean()]);
      return res.json({ success: true, data: { rateCards: cards.map(cardData), total, page, limit } });
    } catch { return res.status(503).json({ success: false, message: "Rate cards could not be loaded." }); }
  }
  async function pricingPreview(req, res) {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["customerId", "zone", "chargeableWeight", "paymentType", "codAmount"].includes(key)) ||
      typeof body.customerId !== "string" || !mongoose.isValidObjectId(body.customerId) ||
      typeof body.zone !== "string" || !body.zone.trim() || body.zone.length > 100 ||
      typeof body.chargeableWeight !== "number" || !Number.isFinite(body.chargeableWeight) || body.chargeableWeight <= 0 ||
      !["COD", "Prepaid", "Pre-paid"].includes(body.paymentType) ||
      (body.codAmount !== undefined && (typeof body.codAmount !== "number" || !Number.isFinite(body.codAmount) || body.codAmount < 0))) {
      return res.status(400).json({ success: false, message: "Customer, zone, positive chargeableWeight and valid paymentType are required." });
    }
    try {
      const customer = await CustomerModel.findOne({ _id: body.customerId, owner: req.user.id }).lean();
      if (!customer) return res.status(404).json({ success: false, message: "Customer not found." });
      const card = customer.rateCardId ? await RateCardModel.findOne({ _id: customer.rateCardId, owner: req.user.id }).lean() : null;
      const compatible = resolveCustomerCard(customer, card ? [card] : []);
      if (card && !compatible) return res.status(409).json({ success: false, message: "Customer rate-card assignment is incompatible." });
      return res.json({ success: true, data: { pricing: buildPricingSnapshot(compatible, {
        zone: body.zone.trim(), chargeableWeight: body.chargeableWeight,
        paymentType: body.paymentType === "COD" ? "COD" : "PREPAID", codAmount: body.codAmount || 0,
      }) } });
    } catch {
      return res.status(503).json({ success: false, message: "Pricing preview could not be calculated." });
    }
  }
  async function get(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid rate card ID." });
    try {
      const card = await RateCardModel.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      if (!card) return res.status(404).json({ success: false, message: "Rate card not found." });
      return res.json({ success: true, data: { rateCard: cardData(card) } });
    } catch { return res.status(503).json({ success: false, message: "Rate card could not be loaded." }); }
  }
  async function create(req, res) {
    let data;
    try { data = validateInput(req.body); }
    catch (error) { return res.status(400).json({ success: false, message: error.message }); }
    try {
      if (data.scope === "CUSTOMER" && !await validateCustomer(data.customerId, req.user.id)) return res.status(404).json({ success: false, message: "Credit customer not found." });
      const card = await RateCardModel.create({ ...data, version: 1, owner: req.user.id });
      return res.status(201).json({ success: true, data: { rateCard: cardData(card) } });
    } catch (error) {
      if (isValidationError(error)) return res.status(400).json({ success: false, message: "Rate card data is invalid." });
      return res.status(503).json({ success: false, message: "Rate card could not be saved." });
    }
  }
  async function update(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid rate card ID." });
    let updates;
    try { updates = validateInput(req.body, { partial: true }); }
    catch (error) { return res.status(400).json({ success: false, message: error.message }); }
    try {
      const current = await RateCardModel.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      if (!current) return res.status(404).json({ success: false, message: "Rate card not found." });
      const merged = { ...current, ...updates };
      if (merged.scope === "CUSTOMER") {
        if (!merged.customerId) return res.status(400).json({ success: false, message: "CUSTOMER cards require customerId." });
        if (!await validateCustomer(String(merged.customerId), req.user.id)) return res.status(404).json({ success: false, message: "Credit customer not found." });
      } else if (merged.customerId != null) return res.status(400).json({ success: false, message: "WALK_IN_STANDARD cards must not reference a customer." });
      if (!await ShipmentModel.findOne({ owner: req.user.id, $or: [
        { "record.rateCardId": req.params.id },
        { "record.pricingSnapshot.rateCardId": req.params.id },
        { "record.pricing.rateCardId": req.params.id },
      ] }).select("_id").lean()) {
        const card = await RateCardModel.findOneAndUpdate({ _id: req.params.id, owner: req.user.id }, { $set: { ...updates, version: Number(current.version || 1) + 1 } }, { new: true, runValidators: true });
        if (!card) return res.status(404).json({ success: false, message: "Rate card not found." });
        return res.json({ success: true, data: { rateCard: cardData(card) } });
      }
      return res.status(409).json({ success: false, message: "This rate card version is used by a shipment and cannot be changed. Create a new card version instead." });
    } catch (error) {
      if (isValidationError(error)) return res.status(400).json({ success: false, message: "Rate card data is invalid." });
      return res.status(503).json({ success: false, message: "Rate card could not be updated." });
    }
  }
  async function createVersion(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid rate card ID." });
    let data;
    try { data = validateInput(req.body); }
    catch (error) { return res.status(400).json({ success: false, message: error.message }); }
    try {
      const current = await RateCardModel.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      if (!current) return res.status(404).json({ success: false, message: "Rate card not found." });
      if (data.scope !== current.scope || String(data.customerId || "") !== String(current.customerId || "")) return res.status(400).json({ success: false, message: "A new version must keep the same scope and customer association." });
      if (data.scope === "CUSTOMER" && !await validateCustomer(data.customerId, req.user.id)) return res.status(404).json({ success: false, message: "Credit customer not found." });
      const card = await RateCardModel.create({ ...data, version: Number(current.version || 1) + 1, owner: req.user.id });
      return res.status(201).json({ success: true, data: { rateCard: cardData(card) } });
    } catch (error) {
      if (isValidationError(error)) return res.status(400).json({ success: false, message: "Rate card data is invalid." });
      return res.status(503).json({ success: false, message: "Rate card version could not be saved." });
    }
  }
  return { list, get, create, update, createVersion, pricingPreview };
}

createCustomerRateCardController.validateInput = validateInput;
createCustomerRateCardController.cardData = cardData;
module.exports = createCustomerRateCardController;
