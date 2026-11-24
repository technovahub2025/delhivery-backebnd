const mongoose = require("mongoose");

function validPhone(value) {
  if (value == null || value === "") return true;
  const digits = value.replace(/\D/g, "");
  return /^\+?[0-9][0-9\s().-]*$/.test(value) && digits.length >= 10 && digits.length <= 15;
}

const contactSchema = new mongoose.Schema({
  name: { type: String, trim: true, maxlength: 200 },
  phone: {
    type: String,
    trim: true,
    maxlength: 25,
    validate: {
      validator: validPhone,
      message: "Enter a valid contact phone number.",
    },
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    maxlength: 254,
    validate: {
      validator: value => value == null || value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
      message: "Enter a valid contact email address.",
    },
  },
}, { _id: false, strict: true });

const addressSchema = new mongoose.Schema({
  addressLines: [{ type: String, trim: true, maxlength: 250 }],
  city: { type: String, trim: true, maxlength: 120 },
  state: { type: String, trim: true, maxlength: 120 },
  pincode: {
    type: String,
    trim: true,
    validate: {
      validator: value => value == null || value === "" || /^[1-9][0-9]{5}$/.test(value),
      message: "Enter a valid six-digit Indian pincode.",
    },
  },
  country: { type: String, trim: true, maxlength: 100 },
}, { _id: false, strict: true });

const schema = new mongoose.Schema({
  owner: { type: String, required: true },
  category: { type: String, required: true, enum: ["CREDIT", "WALK_IN"] },
  companyName: { type: String, trim: true, maxlength: 200 },
  displayName: { type: String, trim: true, maxlength: 200 },
  primaryContact: { type: contactSchema, default: undefined },
  gstin: {
    type: String,
    trim: true,
    uppercase: true,
    maxlength: 15,
    validate: {
      validator: value => value == null || value === "" || /^[A-Z0-9]{15}$/.test(value),
      message: "GSTIN must contain 15 letters or digits.",
    },
  },
  billingAddress: { type: addressSchema, default: undefined },
  shippingAddresses: { type: [addressSchema], default: undefined },
  creditTerms: { type: mongoose.Schema.Types.Mixed, default: undefined },
  creditLimit: { type: Number, min: 0, default: undefined },
  rateCardId: {
    type: mongoose.Schema.Types.ObjectId,
    default: undefined,
    validate: {
      validator: value => value == null || mongoose.isValidObjectId(value),
      message: "rateCardId must be a valid MongoDB ObjectId.",
    },
  },
  monthlyBillingConfig: { type: mongoose.Schema.Types.Mixed, default: undefined },
  outstandingBalance: {
    type: Number,
    validate: {
      validator: value => value == null || Number.isFinite(value),
      message: "outstandingBalance must be a finite number.",
    },
    default: undefined,
  },
  // Exact transaction-maintained balance; legacy outstandingBalance remains API-compatible.
  outstandingBalanceExact: { type: mongoose.Schema.Types.Decimal128, default: undefined },
}, { timestamps: true, bufferCommands: false, strict: true });

schema.index({ owner: 1, category: 1, updatedAt: -1 });
schema.index({ owner: 1, displayName: 1 }, { collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, companyName: 1 }, { collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, "primaryContact.name": 1 }, { collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, "primaryContact.phone": 1 });

module.exports = mongoose.model("Customer", schema);
