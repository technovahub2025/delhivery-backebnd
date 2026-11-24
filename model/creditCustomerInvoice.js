const mongoose = require("mongoose");

const lineSchema = new mongoose.Schema({
  shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "AppShipment", required: true },
  reference: { type: String, required: true },
  waybill: { type: String, default: null },
  shipmentDate: { type: Date, required: true },
  mode: { type: String, required: true, enum: ["SURFACE", "EXPRESS"] },
  currency: { type: String, required: true, maxlength: 3 },
  subtotal: { type: mongoose.Schema.Types.Decimal128, required: true },
  taxAmount: { type: mongoose.Schema.Types.Decimal128, required: true },
  totalAmount: { type: mongoose.Schema.Types.Decimal128, required: true },
  chargeBreakdown: { type: mongoose.Schema.Types.Mixed, required: true },
  pricingSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  rateCardSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false, strict: true });

const auditSchema = new mongoose.Schema({
  action: { type: String, required: true, enum: ["GENERATED", "PAYMENT_ALLOCATED", "PARTIALLY_PAID", "PAID", "ADJUSTED"] },
  actor: { type: String, required: true },
  at: { type: Date, required: true },
  correlationId: { type: String, maxlength: 100, default: undefined },
}, { _id: false, strict: true });

const schema = new mongoose.Schema({
  owner: { type: String, required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
  customerSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  billingConfigurationSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  invoiceNumber: { type: String, required: true, trim: true, maxlength: 100 },
  period: {
    key: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    start: { type: Date, required: true },
    endExclusive: { type: Date, required: true },
  },
  invoiceDate: { type: Date, required: true },
  dueDate: { type: Date, default: null },
  status: { type: String, required: true, enum: ["GENERATED", "PARTIALLY_PAID", "PAID"], default: "GENERATED" },
  currency: { type: String, required: true, maxlength: 3 },
  subtotal: { type: mongoose.Schema.Types.Decimal128, required: true },
  taxAmount: { type: mongoose.Schema.Types.Decimal128, required: true },
  totalAmount: { type: mongoose.Schema.Types.Decimal128, required: true },
  adjustedTotalAmount: mongoose.Schema.Types.Decimal128,
  adjustments: { type: [new mongoose.Schema({
    kind: { type: String, enum: ["DEBIT", "CREDIT"], required: true },
    amount: { type: mongoose.Schema.Types.Decimal128, required: true },
    reason: { type: String, required: true, maxlength: 160 },
    idempotencyKey: { type: String, required: true, maxlength: 120 },
    actor: { type: String, required: true },
    at: { type: Date, required: true },
  }, { _id: false, strict: true })], default: undefined },
  paidAmount: { type: mongoose.Schema.Types.Decimal128, required: true, default: "0" },
  adjustedTotalAmount: mongoose.Schema.Types.Decimal128,
  adjustments: { type: [new mongoose.Schema({
    kind: { type: String, enum: ["DEBIT", "CREDIT"], required: true },
    amount: { type: mongoose.Schema.Types.Decimal128, required: true },
    reason: { type: String, required: true, maxlength: 160 },
    idempotencyKey: { type: String, required: true, maxlength: 120 },
    actor: { type: String, required: true },
    at: { type: Date, required: true },
  }, { _id: false, strict: true })], default: undefined },
  outstandingAmount: { type: mongoose.Schema.Types.Decimal128, required: true },
  lineItems: { type: [lineSchema], required: true, validate: { validator: rows => rows.length > 0, message: "An invoice must contain at least one shipment." } },
  auditTrail: { type: [auditSchema], required: true, default: [] },
  paymentHistory: { type: [new mongoose.Schema({
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerPayment", required: true },
    amount: { type: mongoose.Schema.Types.Decimal128, required: true },
    recordedAt: { type: Date, required: true },
  }, { _id: false, strict: true })], default: [] },
}, { timestamps: true, bufferCommands: false, strict: true });

schema.index({ owner: 1, customerId: 1, "period.key": 1 }, { unique: true, name: "uniq_owner_customer_billing_period" });
schema.index({ owner: 1, invoiceNumber: 1 }, { unique: true, name: "uniq_owner_invoice_number" });
schema.index({ owner: 1, "lineItems.shipmentId": 1 }, { unique: true, name: "uniq_owner_billed_shipment" });
schema.index({ owner: 1, customerId: 1, invoiceDate: -1, _id: -1 });

module.exports = mongoose.model("CreditCustomerInvoice", schema);
