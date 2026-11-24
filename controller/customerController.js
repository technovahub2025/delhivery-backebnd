const mongoose = require("mongoose");
const Customer = require("../model/customer");
const CustomerRateCard = require("../model/customerRateCard");

const CATEGORIES = new Set(["CREDIT", "WALK_IN"]);
const CUSTOMER_FIELDS = new Set([
  "category",
  "companyName",
  "displayName",
  "primaryContact",
  "gstin",
  "billingAddress",
  "shippingAddresses",
  "creditTerms",
  "creditLimit",
  "rateCardId",
  "monthlyBillingConfig",
  "outstandingBalance",
]);
const CONTACT_FIELDS = new Set(["name", "phone", "email"]);
const ADDRESS_FIELDS = new Set(["addressLines", "city", "state", "pincode", "country"]);
const CREDIT_FIELDS = ["creditTerms", "creditLimit", "monthlyBillingConfig", "outstandingBalance"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;
const GSTIN_PATTERN = /^[A-Z0-9]{15}$/;

class InputError extends Error {}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyFields(value, allowed, label) {
  const unsupported = Object.keys(value).filter(key => !allowed.has(key));
  if (unsupported.length) throw new InputError(`${label} contains unsupported fields.`);
}

function cleanString(value, field, maxLength, { pattern, message } = {}) {
  if (typeof value !== "string") throw new InputError(`${field} must be a string.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new InputError(`${field} must be ${maxLength} characters or fewer.`);
  }
  if (normalized && pattern && !pattern.test(normalized)) {
    throw new InputError(message || `${field} has an invalid format.`);
  }
  return normalized;
}

function cleanPhone(value) {
  const phone = cleanString(value, "Contact phone", 25);
  const digits = phone.replace(/\D/g, "");
  if (!/^\+?[0-9][0-9\s().-]*$/.test(phone) || digits.length < 10 || digits.length > 15) {
    throw new InputError("Enter a valid contact phone number.");
  }
  return phone;
}

function cleanContact(value) {
  if (!isPlainObject(value)) throw new InputError("primaryContact must be an object.");
  assertOnlyFields(value, CONTACT_FIELDS, "primaryContact");
  const contact = {};
  if (Object.hasOwn(value, "name")) contact.name = cleanString(value.name, "Contact name", 200);
  if (Object.hasOwn(value, "phone")) {
    contact.phone = cleanPhone(value.phone);
  }
  if (Object.hasOwn(value, "email")) {
    contact.email = cleanString(value.email, "Contact email", 254, {
      pattern: EMAIL_PATTERN,
      message: "Enter a valid contact email address.",
    }).toLowerCase();
  }
  return contact;
}

function cleanAddress(value, fieldName) {
  if (!isPlainObject(value)) throw new InputError(`${fieldName} must be an object.`);
  assertOnlyFields(value, ADDRESS_FIELDS, fieldName);
  const address = {};
  for (const [field, maxLength] of Object.entries({ city: 120, state: 120, country: 100 })) {
    if (Object.hasOwn(value, field)) address[field] = cleanString(value[field], `${fieldName} ${field}`, maxLength);
  }
  if (Object.hasOwn(value, "pincode")) {
    address.pincode = cleanString(value.pincode, `${fieldName} pincode`, 6, {
      pattern: PINCODE_PATTERN,
      message: `${fieldName} pincode must be a valid six-digit Indian pincode.`,
    });
  }
  if (Object.hasOwn(value, "addressLines")) {
    if (!Array.isArray(value.addressLines) || value.addressLines.length > 10) {
      throw new InputError(`${fieldName} addressLines must be an array of at most 10 lines.`);
    }
    address.addressLines = value.addressLines.map((line, index) =>
      cleanString(line, `${fieldName} addressLines[${index}]`, 250)
    );
  }
  return address;
}

function cleanOpaqueJson(value, field) {
  // The credit-terms and billing-configuration shapes are intentionally opaque
  // until the client confirms their business fields.
  if (value === undefined) return value;
  try {
    JSON.stringify(value);
  } catch {
    throw new InputError(`${field} must be valid JSON.`);
  }
  return value;
}

function assertCategoryFields(category, customer) {
  if (category === "WALK_IN" && CREDIT_FIELDS.some(field => customer[field] != null)) {
    throw new InputError("Credit-only fields can only be stored for CREDIT customers.");
  }
}

function validateCustomerInput(body, { partial = false } = {}) {
  if (!isPlainObject(body)) throw new InputError("A customer object is required.");
  assertOnlyFields(body, CUSTOMER_FIELDS, "Customer");
  if (partial && Object.keys(body).length === 0) {
    throw new InputError("At least one customer field is required.");
  }
  if (!partial && !Object.hasOwn(body, "category")) {
    throw new InputError("Customer category is required.");
  }
  if (Object.hasOwn(body, "category") && !CATEGORIES.has(body.category)) {
    throw new InputError("Customer category must be CREDIT or WALK_IN.");
  }

  const data = {};
  for (const field of ["companyName", "displayName"]) {
    if (Object.hasOwn(body, field)) data[field] = cleanString(body[field], field, 200);
  }
  if (Object.hasOwn(body, "primaryContact")) data.primaryContact = cleanContact(body.primaryContact);
  if (Object.hasOwn(body, "gstin")) {
    data.gstin = cleanString(body.gstin, "GSTIN", 15, {
      pattern: GSTIN_PATTERN,
      message: "GSTIN must contain 15 letters or digits.",
    }).toUpperCase();
  }
  if (Object.hasOwn(body, "billingAddress")) {
    data.billingAddress = cleanAddress(body.billingAddress, "billingAddress");
  }
  if (Object.hasOwn(body, "shippingAddresses")) {
    if (!Array.isArray(body.shippingAddresses) || body.shippingAddresses.length > 100) {
      throw new InputError("shippingAddresses must be an array of at most 100 addresses.");
    }
    data.shippingAddresses = body.shippingAddresses.map((address, index) =>
      cleanAddress(address, `shippingAddresses[${index}]`)
    );
  }
  for (const field of ["creditTerms", "monthlyBillingConfig"]) {
    if (Object.hasOwn(body, field)) data[field] = cleanOpaqueJson(body[field], field);
  }
  const cycleStartDay = data.monthlyBillingConfig?.cycleStartDay;
  if (cycleStartDay !== undefined && (!Number.isInteger(cycleStartDay) || cycleStartDay < 1 || cycleStartDay > 28)) {
    throw new InputError("monthlyBillingConfig.cycleStartDay must be an integer from 1 to 28.");
  }
  if (Object.hasOwn(body, "creditLimit")) {
    if (body.creditLimit === null) {
      data.creditLimit = null;
    } else if (typeof body.creditLimit !== "number" || !Number.isFinite(body.creditLimit) || body.creditLimit < 0) {
      throw new InputError("creditLimit must be a finite non-negative number.");
    } else {
      data.creditLimit = body.creditLimit;
    }
  }
  if (Object.hasOwn(body, "outstandingBalance")) {
    if (body.outstandingBalance === null) {
      data.outstandingBalance = null;
    } else if (typeof body.outstandingBalance !== "number" || !Number.isFinite(body.outstandingBalance)) {
      throw new InputError("outstandingBalance must be a finite number.");
    } else {
      data.outstandingBalance = body.outstandingBalance;
    }
  }
  if (Object.hasOwn(body, "rateCardId")) {
    if (body.rateCardId === null || body.rateCardId === "") {
      data.rateCardId = null;
    } else if (!mongoose.isValidObjectId(body.rateCardId)) {
      throw new InputError("rateCardId must be a valid MongoDB ObjectId.");
    } else {
      data.rateCardId = body.rateCardId;
    }
  }
  if (Object.hasOwn(body, "category")) data.category = body.category;
  if (data.category === "WALK_IN") assertCategoryFields(data.category, data);
  return data;
}

function customerData(customer) {
  const value = typeof customer.toObject === "function" ? customer.toObject() : customer;
  const result = { id: String(value._id) };
  for (const field of CUSTOMER_FIELDS) {
    if (value[field] !== undefined) {
      result[field] = field === "rateCardId" && value[field] !== null
        ? String(value[field])
        : value[field];
    }
  }
  if (value.createdAt !== undefined) result.createdAt = value.createdAt;
  if (value.updatedAt !== undefined) result.updatedAt = value.updatedAt;
  return result;
}

function parsePagination(query) {
  const pageText = query.page ?? "1";
  const limitText = query.limit ?? "100";
  if (typeof pageText !== "string" || !/^[1-9]\d*$/.test(pageText) ||
      typeof limitText !== "string" || !/^[1-9]\d*$/.test(limitText) ||
      Number(limitText) > 100 || !Number.isSafeInteger(Number(pageText) * Number(limitText))) {
    throw new InputError("page must be a positive integer; limit must be between 1 and 100.");
  }
  return { page: Number(pageText), limit: Number(limitText) };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isValidationError(error) {
  return error?.name === "ValidationError" || error?.name === "CastError" || error?.code === "BSONError";
}

function createCustomerController(CustomerModel = Customer, RateCardModel = CustomerRateCard) {
  async function assertRateCardAssignment(category, rateCardId, owner, customerId) {
    if (rateCardId == null) return;
    const card = await RateCardModel.findOne({ _id: rateCardId, owner }).select("scope customerId").lean();
    if (!card) {
      const error = new InputError("Rate card not found.");
      error.status = 404;
      throw error;
    }
    if (category === "CREDIT" && (card.scope !== "CUSTOMER" || String(card.customerId) !== String(customerId))) {
      throw new InputError("Credit customers can only use a rate card assigned to that customer.");
    }
    if (category === "WALK_IN" && card.scope !== "WALK_IN_STANDARD") {
      throw new InputError("Walk-in customers can only use a standard walk-in rate card.");
    }
  }

  async function list(req, res) {
    let pagination;
    try {
      pagination = parsePagination(req.query);
      if (req.query.category !== undefined && !CATEGORIES.has(req.query.category)) {
        throw new InputError("Customer category must be CREDIT or WALK_IN.");
      }
      if (req.query.search !== undefined &&
          (typeof req.query.search !== "string" || req.query.search.trim().length > 200)) {
        throw new InputError("search must be 200 characters or fewer.");
      }
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    const filter = { owner: req.user.id };
    if (req.query.category) filter.category = req.query.category;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search) {
      const match = new RegExp(escapeRegex(search), "i");
      filter.$or = [
        { companyName: match },
        { displayName: match },
        { "primaryContact.name": match },
        { "primaryContact.phone": match },
        { "primaryContact.email": match },
      ];
    }

    try {
      const [total, customers] = await Promise.all([
        CustomerModel.countDocuments(filter),
        CustomerModel.find(filter)
          .sort({ updatedAt: -1, _id: -1 })
          .skip((pagination.page - 1) * pagination.limit)
          .limit(pagination.limit)
          .lean(),
      ]);
      return res.json({
        success: true,
        data: {
          customers: customers.map(customerData),
          total,
          page: pagination.page,
          limit: pagination.limit,
        },
      });
    } catch {
      return res.status(503).json({ success: false, message: "Customers could not be loaded." });
    }
  }

  async function get(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid customer ID." });
    }
    try {
      const customer = await CustomerModel.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      if (!customer) return res.status(404).json({ success: false, message: "Customer not found." });
      return res.json({ success: true, data: { customer: customerData(customer) } });
    } catch {
      return res.status(503).json({ success: false, message: "Customer could not be loaded." });
    }
  }

  async function create(req, res) {
    let data;
    try {
      data = validateCustomerInput(req.body);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    try {
      if (data.rateCardId != null) await assertRateCardAssignment(data.category, data.rateCardId, req.user.id, null);
      const customer = await CustomerModel.create({ ...data, owner: req.user.id });
      return res.status(201).json({ success: true, data: { customer: customerData(customer) } });
    } catch (error) {
      if (error instanceof InputError) return res.status(error.status || 400).json({ success: false, message: error.message });
      if (error.code === 11000) {
        return res.status(409).json({ success: false, message: "Customer conflicts with an existing record." });
      }
      if (isValidationError(error)) {
        return res.status(400).json({ success: false, message: "Customer data is invalid." });
      }
      return res.status(503).json({ success: false, message: "Customer could not be saved." });
    }
  }

  async function update(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid customer ID." });
    }
    let updates;
    try {
      updates = validateCustomerInput(req.body, { partial: true });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    try {
      const current = await CustomerModel.findOne({ _id: req.params.id, owner: req.user.id }).lean();
      if (!current) return res.status(404).json({ success: false, message: "Customer not found." });
      const merged = { ...current, ...updates };
      assertCategoryFields(merged.category, merged);
      if (Object.hasOwn(updates, "rateCardId") || (Object.hasOwn(updates, "category") && merged.rateCardId != null)) {
        await assertRateCardAssignment(merged.category, merged.rateCardId, req.user.id, current._id);
      }
      const customer = await CustomerModel.findOneAndUpdate(
        { _id: req.params.id, owner: req.user.id },
        { $set: updates },
        { new: true, runValidators: true }
      );
      if (!customer) return res.status(404).json({ success: false, message: "Customer not found." });
      return res.json({ success: true, data: { customer: customerData(customer) } });
    } catch (error) {
      if (error instanceof InputError) {
        return res.status(error.status || 400).json({ success: false, message: error.message });
      }
      if (error.code === 11000) {
        return res.status(409).json({ success: false, message: "Customer conflicts with an existing record." });
      }
      if (isValidationError(error)) {
        return res.status(400).json({ success: false, message: "Customer data is invalid." });
      }
      return res.status(503).json({ success: false, message: "Customer could not be updated." });
    }
  }

  return { list, get, create, update };
}

createCustomerController.validateCustomerInput = validateCustomerInput;
createCustomerController.customerData = customerData;
module.exports = createCustomerController;
