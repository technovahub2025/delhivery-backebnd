const mongoose = require("mongoose");

const BILLING_DATE_FIELDS = new Set(["createdAt", "record.date"]);
const BILLABLE_STATUS_FIELDS = new Set(["status", "bookingStatus"]);
const GST_TREATMENTS = new Set(["NOT_APPLICABLE", "SNAPSHOT"]);

class BillingError extends Error {
  constructor(message, { status = 400, code = "BILLING_INVALID_REQUEST", details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function parsePeriod(value, startDay = 1) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new BillingError("period must use YYYY-MM format.");
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > 28) throw new BillingError("Billing cycle start day must be an integer from 1 to 28.");
  const [year, month] = value.split("-").map(Number);
  return { key: value, start: new Date(Date.UTC(year, month - 1, startDay)), endExclusive: new Date(Date.UTC(year, month, startDay)) };
}

function expandExponent(text) {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, whole, fraction = "", exponentText] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exponentText);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function plainDecimal(value) {
  if (value == null || typeof value === "boolean") return null;
  let text = String(value?._bsontype === "Decimal128" ? value.toString() : value).trim();
  if (/e/i.test(text)) text = expandExponent(text);
  if (!/^\d+(?:\.\d+)?$/.test(text) || text.length > 34) return null;
  const [whole, fraction = ""] = text.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

function decimalParts(value) {
  const text = plainDecimal(value);
  if (text == null) return null;
  const [whole, fraction = ""] = text.split(".");
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}

function addDecimals(values) {
  const parsed = values.map(decimalParts);
  if (parsed.some(value => value == null)) return null;
  const scale = Math.max(0, ...parsed.map(value => value.scale));
  let total = 0n;
  for (const value of parsed) total += value.coefficient * (10n ** BigInt(scale - value.scale));
  const digits = total.toString().padStart(scale + 1, "0");
  if (!scale) return digits;
  const whole = digits.slice(0, -scale).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function subtractDecimals(left, right) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (!a || !b) return null;
  const scale = Math.max(a.scale, b.scale);
  const value = a.coefficient * (10n ** BigInt(scale - a.scale)) - b.coefficient * (10n ** BigInt(scale - b.scale));
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  if (!scale) return `${negative ? "-" : ""}${digits}`;
  const whole = digits.slice(0, -scale).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${fraction ? `${whole}.${fraction}` : whole}`;
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function snapshotCustomer(customer) {
  return {
    id: String(customer._id), category: customer.category,
    companyName: customer.companyName || "", displayName: customer.displayName || "",
    gstin: customer.gstin || "", primaryContact: customer.primaryContact || null,
    billingAddress: customer.billingAddress || null,
  };
}

function toLine(row, config) {
  if (!row) return { error: "The shipment could not be reloaded in the billing transaction." };
  const record = row.record || {};
  const mode = String(record.mode || "").trim().toUpperCase();
  if (!["SURFACE", "EXPRESS"].includes(mode)) return { error: "Shipment mode is missing or unsupported in the saved booking." };
  const pricing = record.customerSellingPriceSnapshot;
  if (!pricing || !["READY", "PARTIAL"].includes(pricing.status)) return { error: `Historical customer pricing is ${pricing?.status || "missing"}; only READY modes can be billed.` };
  const modePricing = pricing.customerSelling?.[mode];
  if (!modePricing || modePricing.status !== "READY") return { error: "Historical selling-price details for the booked mode are unavailable." };
  const sellingPrice = plainDecimal(modePricing.sellingPrice);
  if (sellingPrice == null) return { error: "The saved customer selling amount is missing or invalid." };
  const currency = String(pricing.card?.currency || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { error: "Historical pricing currency is not captured." };

  let subtotal; let taxAmount; let totalAmount;
  if (config.gstTreatment === "NOT_APPLICABLE") {
    if (plainDecimal(modePricing.gstAmount) && plainDecimal(modePricing.gstAmount) !== "0") return { error: "The booking has GST charges but the billing configuration is marked NOT_APPLICABLE." };
    subtotal = sellingPrice;
    taxAmount = "0";
    totalAmount = sellingPrice;
  } else if (config.gstTreatment === "SNAPSHOT") {
    subtotal = plainDecimal(modePricing.taxableAmount);
    taxAmount = plainDecimal(modePricing.gstAmount);
    totalAmount = plainDecimal(modePricing.invoiceAmount);
    if ([subtotal, taxAmount, totalAmount].some(value => value == null)) return { error: "The booking snapshot does not contain the configured GST taxable amount, tax amount and invoice total." };
  } else return { error: "Customer GST treatment is not configured." };

  const shipmentDate = asDate(config.billingDateField === "createdAt" ? row.createdAt : record.date);
  if (!shipmentDate) return { error: "Shipment billing date is invalid." };
  const reference = String(row.reference || record.reference || "").trim();
  if (!reference) return { error: "The booking has no saved order reference." };
  return { line: {
    shipmentId: String(row._id), reference, waybill: row.waybill || record.waybill || null,
    shipmentDate, mode, currency, subtotal, taxAmount, totalAmount,
    chargeBreakdown: structuredClone(modePricing), pricingSnapshot: structuredClone(pricing),
    rateCardSnapshot: structuredClone(record.rateCardSnapshot || null),
  } };
}

function findQuery(Model, filter, session) {
  let query = Model.find(filter);
  if (session && query?.session) query = query.session(session);
  return query;
}

async function findMany(Model, filter, session, sort) {
  let query = findQuery(Model, filter, session);
  if (sort && query?.sort) query = query.sort(sort);
  if (query?.lean) query = query.lean();
  return await query;
}

async function findOne(Model, filter, session) {
  let query = Model.findOne(filter);
  if (session && query?.session) query = query.session(session);
  if (query?.lean) query = query.lean();
  return await query;
}

function billedShipmentIds(invoices) {
  return new Set(invoices.flatMap(invoice => invoice.lineItems || []).map(line => String(line.shipmentId)));
}

function bookedShipment(row) {
  const bookingStatus = String(row.record?.bookingStatus || "").toUpperCase();
  return ["AWB_GENERATED", "BOOKED_AWB_PENDING"].includes(bookingStatus) || Boolean(row.waybill || row.record?.waybill);
}

function shipmentStatement(shipments, invoices, period, dateField, eligibility) {
  const billed = new Map(invoices.flatMap(invoice => (invoice.lineItems || []).map(line => [String(line.shipmentId), { invoiceNumber: invoice.invoiceNumber, line }])));
  const eligible = new Set(eligibility.eligibleShipments.map(row => row.shipmentId));
  const blocked = new Set(eligibility.blockedShipments.map(row => row.shipmentId));
  const entries = [];
  for (const row of shipments) {
    const record = row.record || {};
    if (!bookedShipment(row)) continue;
    const date = asDate(dateField === "createdAt" ? row.createdAt : record.date);
    if (!date || date < period.start || date >= period.endExclusive) continue;
    const id = String(row._id);
    const invoice = billed.get(id);
    const snapshot = record.customerSellingPriceSnapshot;
    const selling = snapshot?.customerSelling?.[String(record.mode || "").toUpperCase()];
    entries.push({
      shipmentId: id, reference: row.reference || record.reference || "", waybill: row.waybill || record.waybill || null,
      shipmentDate: date.toISOString(), shipmentStatus: record.status || record.bookingStatus || null,
      billingStatus: invoice ? "INVOICED" : eligible.has(id) ? "ELIGIBLE" : blocked.has(id) ? "BLOCKED" : "NOT_ELIGIBLE",
      invoiceNumber: invoice?.invoiceNumber ?? null,
      amount: plainDecimal(invoice?.line?.totalAmount ?? selling?.sellingPrice),
      currency: invoice?.line?.currency || selling?.currency || snapshot?.card?.currency || null,
      sample: record.mockOnly === true || selling?.status === "TEST",
    });
  }
  return entries.sort((a, b) => a.shipmentDate.localeCompare(b.shipmentDate) || a.shipmentId.localeCompare(b.shipmentId));
}

function makeEligibility(customer, shipments, invoices, period) {
  const config = customer.monthlyBillingConfig && typeof customer.monthlyBillingConfig === "object" ? customer.monthlyBillingConfig : {};
  const blockers = [];
  if (!BILLING_DATE_FIELDS.has(config.billingDateField)) blockers.push("Monthly billing requires a configured billingDateField (createdAt or record.date). No shipment date rule is assumed.");
  if (!BILLABLE_STATUS_FIELDS.has(config.billableStatusField) || !Array.isArray(config.billableStatuses) || !config.billableStatuses.length || config.billableStatuses.some(value => typeof value !== "string" || !value.trim())) blockers.push("Monthly billing requires explicit billableStatusField and billableStatuses configuration.");
  if (!GST_TREATMENTS.has(config.gstTreatment)) blockers.push("GST treatment must be confirmed as NOT_APPLICABLE or SNAPSHOT before invoicing.");

  const eligibleShipments = [];
  const blockedShipments = [];
  const customerShipments = shipments.filter(row => row.record?.customerSnapshot?.category === "CREDIT" && String(row.record.customerSnapshot.id || "") === String(customer._id));
  if (blockers.length) return {
    eligibleShipments, blockedShipments, blockers,
    configuration: { status: "CONFIGURATION_REQUIRED", billingDateField: config.billingDateField || null, billableStatusField: config.billableStatusField || null, billableStatuses: config.billableStatuses || [], gstTreatment: config.gstTreatment || null },
  };

  const billedIds = billedShipmentIds(invoices);
  const statuses = new Set(config.billableStatuses.map(value => value.trim()));
  for (const row of customerShipments) {
    const record = row.record || {};
    if (!bookedShipment(row) || !statuses.has(String(record[config.billableStatusField] || ""))) continue;
    const shipmentDate = asDate(config.billingDateField === "createdAt" ? row.createdAt : record.date);
    if (!shipmentDate || shipmentDate < period.start || shipmentDate >= period.endExclusive) continue;
    const item = { shipmentId: String(row._id), reference: row.reference || record.reference || "", waybill: row.waybill || record.waybill || null, shipmentDate: shipmentDate.toISOString(), mode: record.mode || null };
    if (billedIds.has(item.shipmentId)) {
      blockedShipments.push({ ...item, blockers: ["This shipment is already included in a customer invoice."] });
      continue;
    }
    const result = toLine(row, config);
    if (result.error) {
      blockedShipments.push({ ...item, blockers: [result.error] });
      continue;
    }
    eligibleShipments.push({ ...item, amount: result.line.totalAmount, currency: result.line.currency, pricingStatus: "READY", chargeBreakdown: result.line.chargeBreakdown });
  }

  if (new Set(eligibleShipments.map(item => item.currency)).size > 1) blockers.push("Shipments in different currencies cannot be combined in one invoice.");
  if (!eligibleShipments.length && !blockedShipments.length) blockers.push("No booked shipments match the configured billing period and billable status.");
  if (blockedShipments.length) blockers.push("One or more matching shipments cannot be invoiced; resolve or explicitly exclude them before generating a consolidated invoice.");
  return {
    eligibleShipments, blockedShipments, blockers,
    configuration: { status: blockers.length ? "CONFIGURATION_REQUIRED" : "READY", billingDateField: config.billingDateField, billableStatusField: config.billableStatusField, billableStatuses: config.billableStatuses, gstTreatment: config.gstTreatment },
  };
}

function createCreditCustomerBillingService({ Customer, Shipment, Invoice, mongooseInstance = mongoose, now = () => new Date() }) {
  async function getCustomer(owner, customerId, session) {
    if (!mongooseInstance.isValidObjectId(customerId)) throw new BillingError("customerId must be a valid customer ID.");
    const customer = await findOne(Customer, { _id: customerId, owner, category: "CREDIT" }, session);
    if (!customer) throw new BillingError("Credit customer not found.", { status: 404, code: "CREDIT_CUSTOMER_NOT_FOUND" });
    return customer;
  }

  async function getEligibility(owner, customerId, periodValue, session) {
    const customer = await getCustomer(owner, customerId, session);
    const config = customer.monthlyBillingConfig || {};
    let period = parsePeriod(periodValue, config.cycleStartDay ?? 1);
    const invoices = await findMany(Invoice, { owner, customerId: customer._id }, session);
    const historicalPeriod = invoices.find(invoice => invoice.period?.key === period.key)?.period;
    const start = asDate(historicalPeriod?.start);
    const endExclusive = asDate(historicalPeriod?.endExclusive);
    if (start && endExclusive && start < endExclusive) period = { key: period.key, start, endExclusive };
    const shipments = await findMany(Shipment, { owner, state: "saved", kind: "forward", "record.customerSnapshot.id": String(customer._id) }, session);
    const eligibility = makeEligibility(customer, shipments, invoices, period);
    const dateBasis = BILLING_DATE_FIELDS.has(config.billingDateField) ? config.billingDateField : null;
    return {
      ...eligibility,
      statement: { dateBasis, entries: dateBasis ? shipmentStatement(shipments, invoices, period, dateBasis, eligibility) : [] },
      period: { key: period.key, start: period.start.toISOString(), endExclusive: period.endExclusive.toISOString() },
      customer: snapshotCustomer(customer),
    };
  }

  async function generate({ owner, actor, customerId, period: periodValue, invoiceNumber, invoiceDate, dueDate, correlationId }) {
    const normalizedNumber = typeof invoiceNumber === "string" ? invoiceNumber.trim() : "";
    if (!normalizedNumber || normalizedNumber.length > 100) throw new BillingError("A unique invoice number is required (maximum 100 characters). The numbering format is not assumed.");
    const period = parsePeriod(periodValue);
    const issuedAt = invoiceDate ? asDate(invoiceDate) : asDate(now());
    const dueAt = dueDate ? asDate(dueDate) : null;
    if (!issuedAt) throw new BillingError("invoiceDate must be a valid date.");
    if (dueDate && !dueAt) throw new BillingError("dueDate must be a valid date.");
    if (dueAt && dueAt < issuedAt) throw new BillingError("dueDate cannot be earlier than invoiceDate.");
    if (!mongooseInstance.startSession) throw new BillingError("MongoDB transactions are required for safe invoice generation.", { status: 503, code: "BILLING_TRANSACTION_UNAVAILABLE" });

    let session;
    try {
      session = await mongooseInstance.startSession();
      if (Invoice.init) await Invoice.init();
      let generated;
      await session.withTransaction(async () => {
        if (await findOne(Invoice, { owner, customerId, "period.key": period.key }, session)) throw new BillingError("A consolidated invoice already exists for this customer and period.", { status: 409, code: "DUPLICATE_BILLING_PERIOD" });
        if (await findOne(Invoice, { owner, invoiceNumber: normalizedNumber }, session)) throw new BillingError("This invoice number is already used in this account.", { status: 409, code: "DUPLICATE_INVOICE_NUMBER" });
        const preview = await getEligibility(owner, customerId, period.key, session);
        if (preview.blockers.length || preview.blockedShipments.length || !preview.eligibleShipments.length) throw new BillingError("Invoice generation is blocked by billing configuration or shipment data.", { status: 422, code: "BILLING_CONFIGURATION_REQUIRED", details: preview });

        const customer = await getCustomer(owner, customerId, session);
        const sourceShipments = await findMany(Shipment, { owner, state: "saved", kind: "forward", "record.customerSnapshot.id": String(customer._id) }, session);
        const lookup = new Map(sourceShipments.map(row => [String(row._id), row]));
        const lines = preview.eligibleShipments.map(item => {
          const result = toLine(lookup.get(item.shipmentId), customer.monthlyBillingConfig || {});
          if (result.error) throw new BillingError(result.error, { status: 422, code: "BILLING_CONFIGURATION_REQUIRED" });
          return result.line;
        });
        const currency = lines[0].currency;
        const subtotal = addDecimals(lines.map(line => line.subtotal));
        const taxAmount = addDecimals(lines.map(line => line.taxAmount));
        const totalAmount = addDecimals(lines.map(line => line.totalAmount));
        if ([subtotal, taxAmount, totalAmount].some(value => value == null)) throw new BillingError("Invoice totals could not be represented exactly.", { status: 422, code: "INVALID_CURRENCY_AMOUNT" });
        const data = {
          owner, customerId, customerSnapshot: snapshotCustomer(customer),
          billingConfigurationSnapshot: structuredClone(customer.monthlyBillingConfig),
          invoiceNumber: normalizedNumber, period: preview.period, invoiceDate: issuedAt, dueDate: dueAt,
          status: "GENERATED", currency, subtotal, taxAmount, totalAmount, lineItems: lines,
          paidAmount: "0", outstandingAmount: totalAmount,
          auditTrail: [{ action: "GENERATED", actor: String(actor), at: asDate(now()), ...(correlationId ? { correlationId: String(correlationId).slice(0, 100) } : {}) }],
        };
        const rows = await Invoice.create([data], { session });
        generated = rows[0];
      });
      return generated;
    } catch (error) {
      if (error?.code === 11000) throw new BillingError("This period, invoice number, or shipment has already been billed.", { status: 409, code: "DUPLICATE_BILLING_RECORD" });
      throw error;
    } finally { if (session) await session.endSession(); }
  }

  return {
    listCustomers: async owner => {
      let query = Customer.find({ owner, category: "CREDIT" });
      if (query?.select) query = query.select("category companyName displayName gstin");
      if (query?.sort) query = query.sort({ displayName: 1, companyName: 1 });
      if (query?.lean) query = query.lean();
      return await query;
    },
    getEligibility,
    listInvoices: async (owner, { customerId, period: periodValue } = {}) => {
      const filter = { owner };
      if (customerId) {
        if (!mongooseInstance.isValidObjectId(customerId)) throw new BillingError("customerId must be a valid customer ID.");
        filter.customerId = customerId;
      }
      if (periodValue) filter["period.key"] = parsePeriod(periodValue).key;
      return findMany(Invoice, filter, null, { invoiceDate: -1, createdAt: -1, _id: -1 });
    },
    getInvoice: async (owner, id) => {
      if (!mongooseInstance.isValidObjectId(id)) throw new BillingError("Invalid invoice ID.");
      return findOne(Invoice, { _id: id, owner });
    },
    generate,
  };
}

module.exports = { BillingError, parsePeriod, plainDecimal, addDecimals, subtractDecimals, makeEligibility, createCreditCustomerBillingService };
