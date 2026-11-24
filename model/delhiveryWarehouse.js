const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  owner: { type: String, required: true, index: true },
  // Delhivery edits warehouses by name; the normalized key therefore acts as
  // the provider-side identifier and must be unique across this API account.
  name: { type: String, required: true, trim: true },
  nameKey: { type: String, required: true, unique: true },
  state: { type: String, enum: ["creating", "saved"], required: true, default: "creating" },
  registrationStatus: {
    type: String,
    enum: ["CREATING", "REGISTERED", "FAILED", "OUTCOME_UNCONFIRMED"],
    default: function registrationStatusDefault() { return this.state === "saved" ? "REGISTERED" : "CREATING"; },
  },
  updateStatus: { type: String, enum: ["PENDING", "SUCCEEDED", "FAILED", "OUTCOME_UNCONFIRMED"], default: undefined },
  lastOperationCode: { type: String, default: "" },
  lastOperationAt: { type: Date, default: undefined },
  details: { type: mongoose.Schema.Types.Mixed, required: true },
  receipt: { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { timestamps: true, bufferCommands: false });

schema.index({ owner:  1, nameKey: 1 }, { unique: true });

module.exports = mongoose.model("DelhiveryWarehouse", schema);
