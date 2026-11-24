const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  owner: { type: String, required: true },
  requestId: { type: String, required: true },
  count: { type: Number, required: true, min: 1, max: 10000 },
  state: { type: String, enum: ["PENDING", "CONFIRMED", "UNCONFIRMED", "NOT_SENT"], required: true },
  waybills: { type: [String], default: undefined },
}, { timestamps: true, bufferCommands: false });

schema.index({ owner: 1, requestId: 1 }, { unique: true });
schema.index({ waybills: 1 }, {
  unique: true,
  partialFilterExpression: { "waybills.0": { $exists: true } },
});

module.exports = mongoose.model("WaybillAllocation", schema);
