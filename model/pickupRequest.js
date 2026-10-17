const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  owner: { type: String, required: true, index: true },
  carrierRequestId: { type: String, default: "" },
  pickupDate: { type: String, required: true },
  pickupTime: { type: String, required: true },
  warehouse: { type: String, required: true },
  packageCount: { type: Number, required: true, min: 1 },
  status: { type: String, default: "Scheduled" },
  request: { type: mongoose.Schema.Types.Mixed, required: true },
  carrierResponse: { type: mongoose.Schema.Types.Mixed, required: true }
}, { timestamps: true, bufferCommands: false });

schema.index({ owner: 1, createdAt: -1 });

module.exports = mongoose.model("PickupRequest", schema);
