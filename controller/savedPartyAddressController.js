const mongoose = require("mongoose");
const SavedPartyAddress = require("../model/savedPartyAddress");
const Customer = require("../model/customer");

const PARTY_TYPES = new Set(["SHIPPER", "CONSIGNEE", "PICKUP"]);
const FIELDS = new Set(["customerId", "partyType", "companyName", "contactName", "phone", "email", "addressLines", "city", "state", "pincode", "gstin"]);
const QUERY_FIELDS = new Set(["customerId", "includeUnassigned", "partyType", "search", "page", "limit"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PINCODE = /^[1-9][0-9]{5}$/;
const GSTIN = /^[A-Z0-9]{15}$/;

class InputError extends Error {}

function isObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateInput(body, { partial = false } = {}) {
  if (!isObject(body)) throw new InputError("A party address object is required.");
  const unknown = Object.keys(body).filter(key => !FIELDS.has(key));
  if (unknown.length) throw new InputError("Party address contains unsupported fields.");
  if (partial && !Object.keys(body).length) throw new InputError("At least one party address field is required.");
  if (!partial && !Object.hasOwn(body, "partyType")) throw new InputError("partyType is required.");
  if (Object.hasOwn(body, "partyType") && !PARTY_TYPES.has(body.partyType)) {
    throw new InputError("partyType must be SHIPPER, CONSIGNEE, or PICKUP.");
  }
  const output = {};
  if (Object.hasOwn(body, "partyType")) output.partyType = body.partyType;
  if (Object.hasOwn(body, "customerId")) {
    if (body.customerId === null || body.customerId === "") output.customerId = null;
    else if (typeof body.customerId !== "string" || !mongoose.isValidObjectId(body.customerId)) {
      throw new InputError("customerId must be a valid MongoDB ObjectId or null.");
    } else output.customerId = body.customerId;
  }
  for (const [field, max] of Object.entries({ companyName: 200, contactName: 200, phone: 25, email: 254, city: 120, state: 120, pincode: 6, gstin: 15 })) {
    if (!Object.hasOwn(body, field)) continue;
    if (typeof body[field] !== "string") throw new InputError(`${field} must be a string.`);
    const value = body[field].trim();
    if (value.length > max) throw new InputError(`${field} must be ${max} characters or fewer.`);
    if (field === "phone" && value) {
      const digits = value.replace(/\D/g, "");
      if (!/^\+?[0-9][0-9\s().-]*$/.test(value) || digits.length < 10 || digits.length > 15) throw new InputError("Enter a valid contact phone number.");
    }
    if (field === "email" && value && !EMAIL.test(value)) throw new InputError("Enter a valid contact email address.");
    if (field === "pincode" && value && !PINCODE.test(value)) throw new InputError("pincode must be a valid six-digit Indian pincode.");
    if (field === "gstin" && value && !GSTIN.test(value.toUpperCase())) throw new InputError("GSTIN must contain 15 letters or digits.");
    output[field] = field === "email" ? value.toLowerCase() : field === "gstin" ? value.toUpperCase() : value;
  }
  if (Object.hasOwn(body, "addressLines")) {
    if (!Array.isArray(body.addressLines) || body.addressLines.length > 10 || body.addressLines.some(line => typeof line !== "string" || line.trim().length > 250)) {
      throw new InputError("addressLines must be an array of at most 10 strings, each no longer than 250 characters.");
    }
    output.addressLines = body.addressLines.map(line => line.trim());
  }
  return output;
}

function parseListQuery(query) {
  const unknown = Object.keys(query).filter(key => !QUERY_FIELDS.has(key));
  if (unknown.length) throw new InputError("Unsupported party address filter.");
  if (query.partyType && !PARTY_TYPES.has(query.partyType)) throw new InputError("partyType must be SHIPPER, CONSIGNEE, or PICKUP.");
  if (query.customerId && !mongoose.isValidObjectId(query.customerId)) throw new InputError("customerId must be a valid MongoDB ObjectId.");
  if (query.includeUnassigned !== undefined && (!query.customerId || !["true", "false"].includes(query.includeUnassigned))) {
    throw new InputError("includeUnassigned requires a customer filter and a boolean value.");
  }
  if (query.search !== undefined && (typeof query.search !== "string" || query.search.trim().length > 200)) throw new InputError("search must be 200 characters or fewer.");
  const pageText = query.page ?? "1";
  const limitText = query.limit ?? "100";
  if (!/^[1-9]\d*$/.test(pageText) || !/^[1-9]\d*$/.test(limitText) || Number(limitText) > 100) throw new InputError("page must be positive and limit must be between 1 and 100.");
  return { page: Number(pageText), limit: Number(limitText) };
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function isValidationError(error) { return error?.name === "ValidationError" || error?.name === "CastError" || error?.code === "BSONError"; }

function partyAddressData(record) {
  const value = typeof record.toObject === "function" ? record.toObject() : record;
  const result = { id: String(value._id) };
  for (const field of FIELDS) if (value[field] !== undefined) result[field] = field === "customerId" && value[field] != null ? String(value[field]) : value[field];
  if (value.createdAt !== undefined) result.createdAt = value.createdAt;
  if (value.updatedAt !== undefined) result.updatedAt = value.updatedAt;
  return result;
}

function createSavedPartyAddressController({ SavedPartyAddressModel = SavedPartyAddress, CustomerModel = Customer } = {}) {
  async function ownedCustomer(customerId, owner) {
    if (customerId == null) return true;
    const customer = await CustomerModel.findOne({ _id: customerId, owner }).select("_id").lean();
    return Boolean(customer);
  }

  async function list(req, res) {
    let pagination;
    try { pagination = parseListQuery(req.query); }
    catch (error) { return res.status(400).json({ success: false, message: error.message }); }
    try {
      if (req.query.customerId && !await ownedCustomer(req.query.customerId, req.user.id)) return res.status(404).json({ success: false, message: "Customer not found." });
      const filter = { owner: req.user.id };
      if (req.query.customerId) filter.customerId = req.query.includeUnassigned === "true" ? { $in: [req.query.customerId, null] } : req.query.customerId;
      if (req.query.partyType) filter.partyType = req.query.partyType;
      const search = req.query.search?.trim();
      if (search) {
        const regex = new RegExp(escapeRegex(search), "i");
        filter.$or = ["companyName", "contactName", "phone", "email", "addressLines", "city", "state", "pincode", "gstin"].map(field => ({ [field]: regex }));
      }
      const [total, records] = await Promise.all([
        SavedPartyAddressModel.countDocuments(filter),
        SavedPartyAddressModel.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((pagination.page - 1) * pagination.limit).limit(pagination.limit).lean(),
      ]);
      return res.json({ success: true, data: { partyAddresses: records.map(partyAddressData), total, page: pagination.page, limit: pagination.limit } });
    } catch { return res.status(503).json({ success: false, message: "Party addresses could not be loaded." }); }
  }

  async function get(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid party address ID." });
    try {
      const record = await SavedPartyAddressModel.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      if (!record) return res.status(404).json({ success: false, message: "Party address not found." });
      return res.json({ success: true, data: { partyAddress: partyAddressData(record) } });
    } catch { return res.status(503).json({ success: false, message: "Party address could not be loaded." }); }
  }

  async function create(req, res) {
    let data;
    try { data = validateInput(req.body); }
    catch (error) { return res.status(400).json({ success: false, message: error.message }); }
    try {
      if (!await ownedCustomer(data.customerId, req.user.id)) return res.status(404).json({ success: false, message: "Customer not found." });
      const record = await SavedPartyAddressModel.create({ ...data, owner: req.user.id });
      return res.status(201).json({ success: true, data: { partyAddress: partyAddressData(record) } });
    } catch (error) {
      if (isValidationError(error)) return res.status(400).json({ success: false, message: "Party address data is invalid." });
      return res.status(503).json({ success: false, message: "Party address could not be saved." });
    }
  }

  async function update(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid party address ID." });
    let updates;
    try { updates = validateInput(req.body, { partial: true }); }
    catch (error) { return res.status(400).json({ success: false, message: error.message }); }
    try {
      const current = await SavedPartyAddressModel.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      if (!current) return res.status(404).json({ success: false, message: "Party address not found." });
      if (Object.hasOwn(updates, "customerId") && !await ownedCustomer(updates.customerId, req.user.id)) return res.status(404).json({ success: false, message: "Customer not found." });
      const record = await SavedPartyAddressModel.findOneAndUpdate({ _id: req.params.id, owner: req.user.id }, { $set: updates }, { new: true, runValidators: true });
      if (!record) return res.status(404).json({ success: false, message: "Party address not found." });
      return res.json({ success: true, data: { partyAddress: partyAddressData(record) } });
    } catch (error) {
      if (isValidationError(error)) return res.status(400).json({ success: false, message: "Party address data is invalid." });
      return res.status(503).json({ success: false, message: "Party address could not be updated." });
    }
  }
  return { list, get, create, update };
}

createSavedPartyAddressController.validateInput = validateInput;
createSavedPartyAddressController.partyAddressData = partyAddressData;
module.exports = createSavedPartyAddressController;
