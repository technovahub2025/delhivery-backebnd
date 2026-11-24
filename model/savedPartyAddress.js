const mongoose = require("mongoose");

function validPhone(value) {
  if (value == null || value === "") return true;
  const digits = value.replace(/\D/g, "");
  return /^\+?[0-9][0-9\s().-]*$/.test(value) && digits.length >= 10 && digits.length <= 15;
}

const schema = new mongoose.Schema({
  owner: { type: String, required: true },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer",
    default: undefined,
    validate: {
      validator: value => value == null || mongoose.isValidObjectId(value),
      message: "customerId must be a valid MongoDB ObjectId.",
    },
  },
  partyType: { type: String, required: true, enum: ["SHIPPER", "CONSIGNEE", "PICKUP"] },
  companyName: { type: String, trim: true, maxlength: 200 },
  contactName: { type: String, trim: true, maxlength: 200 },
  phone: {
    type: String,
    trim: true,
    maxlength: 25,
    validate: { validator: validPhone, message: "Enter a valid contact phone number." },
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
}, { timestamps: true, bufferCommands: false, strict: true });

schema.index({ owner: 1, customerId: 1, partyType: 1, updatedAt: -1 });
schema.index({ owner: 1, partyType: 1, pincode: 1 });
schema.index({ owner: 1, phone: 1 });
schema.index({ owner: 1, contactName: 1 }, { collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, companyName: 1 }, { collation: { locale: "en", strength: 2 } });

module.exports = mongoose.model("SavedPartyAddress", schema);
