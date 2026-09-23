const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  owner: { type: String, required: true },
  reference: { type: String, required: true },
  state: { type: String, enum: ["creating", "saved"], default: "creating" },
  waybill: String,
  record: mongoose.Schema.Types.Mixed,
  receipt: mongoose.Schema.Types.Mixed,
}, { timestamps: true, bufferCommands: false });
schema.index({ owner: 1, reference: 1 }, { unique: true });
schema.index({ owner: 1, state: 1, createdAt: -1, _id: -1 });
module.exports = mongoose.model("AppShipment", schema);
