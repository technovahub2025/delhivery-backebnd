const mongoose = require("mongoose");

const amountSchemaType = {
  type: mongoose.Schema.Types.Decimal128,
  required: true,
  validate: {
    validator: value => value == null || Number(value.toString()) >= 0,
    message: "Amount must be non-negative.",
  },
};

const weightSlabSchema = new mongoose.Schema({
  minWeight: { type: Number, required: true, min: 0 },
  maxWeight: { type: Number, required: true, min: 0 },
  baseRate: amountSchemaType,
  additionalWeightCharge: { ...amountSchemaType, required: false },
  includedWeight: { type: Number, min: 0 },
  additionalWeightIncrement: { type: Number, min: 0, validate: value => value > 0 },
}, { _id: false, strict: true });
weightSlabSchema.path("maxWeight").validate(function (value) {
  return this.minWeight == null || value > this.minWeight;
}, "maxWeight must be greater than minWeight.");

const modeRateSchema = new mongoose.Schema({
  mode: { type: String, required: true, enum: ["SURFACE", "EXPRESS"] },
  weightSlabs: { type: [weightSlabSchema], required: true, validate: { validator: rows => rows.length > 0, message: "Each mode requires at least one weight slab." } },
}, { _id: false, strict: true });

const zoneRateSchema = new mongoose.Schema({
  zone: { type: String, required: true, trim: true, maxlength: 100 },
  modes: { type: [modeRateSchema], required: true, validate: { validator: rows => rows.length > 0, message: "Each zone requires at least one shipping mode." } },
}, { _id: false, strict: true });

const surchargeSchema = new mongoose.Schema({
  kind: { type: String, required: true, enum: ["FUEL", "COD", "OTHER"] },
  label: { type: String, trim: true, maxlength: 120 },
  calculationType: { type: String, trim: true, maxlength: 80 },
  basis: { type: String, trim: true, maxlength: 120 },
  value: amountSchemaType,
}, { _id: false, strict: true });

const gstRuleSchema = new mongoose.Schema({
  name: { type: String, trim: true, maxlength: 120 },
  rate: amountSchemaType,
  inclusive: Boolean,
}, { _id: false, strict: true });

const schema = new mongoose.Schema({
  owner: { type: String, required: true },
  scope: { type: String, required: true, enum: ["CUSTOMER", "WALK_IN_STANDARD"] },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer",
    required: function () { return this.scope === "CUSTOMER"; },
    default: undefined,
    validate: { validator: value => value == null || mongoose.isValidObjectId(value), message: "customerId must be a valid MongoDB ObjectId." },
  },
  name: { type: String, trim: true, maxlength: 200 },
  version: { type: Number, required: true, default: 1, min: 1, validate: Number.isInteger },
  currency: { type: String, trim: true, uppercase: true, maxlength: 3 },
  effectiveFrom: Date,
  effectiveTo: Date,
  zoneRates: { type: [zoneRateSchema], required: true, validate: { validator: rows => rows.length > 0, message: "At least one zone rate is required." } },
  surcharges: { type: [surchargeSchema], default: undefined },
  gstRules: { type: [gstRuleSchema], default: undefined },
}, { timestamps: true, bufferCommands: false, strict: true });

schema.path("customerId").validate(function (value) {
  return this.scope === "CUSTOMER" ? value != null : value == null;
}, "CUSTOMER cards require customerId; WALK_IN_STANDARD cards must not reference a customer.");
schema.path("effectiveTo").validate(function (value) {
  return value == null || this.effectiveFrom == null || value >= this.effectiveFrom;
}, "effectiveTo must be on or after effectiveFrom.");
schema.index({ owner: 1, scope: 1, customerId: 1, effectiveFrom: 1 });
schema.index({ owner: 1, updatedAt: -1 });

module.exports = mongoose.model("CustomerRateCard", schema);
