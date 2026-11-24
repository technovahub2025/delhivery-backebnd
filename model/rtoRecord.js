const mongoose = require("mongoose");

const statusEventSchema = new mongoose.Schema({
  eventKey: { type: String, required: true },
  shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "AppShipment", required: true },
  providerCode: { type: String, default: "" },
  providerEventId: { type: String, default: "" },
  status: { type: String, required: true },
  lifecycleState: { type: String, enum: ["ACTIVE", "COMPLETED", "UNRESOLVED"], default: "UNRESOLVED", required: true },
  reason: { type: String, default: "" },
  location: { type: String, default: "" },
  occurredAt: { type: Date, required: true },
  source: { type: String, default: "TRACKING" },
}, { _id: false });

const schema = new mongoose.Schema({
  owner: { type: String, required: true },
  originalShipment: { type: mongoose.Schema.Types.ObjectId, ref: "AppShipment", required: true },
  returnShipment: { type: mongoose.Schema.Types.ObjectId, ref: "AppShipment", default: undefined },
  originalWaybill: { type: String, required: true },
  originalReference: { type: String, default: "" },
  providerCode: { type: String, default: "" },
  triggerEventKey: { type: String, required: true },
  reason: { type: String, default: "" },
  status: { type: String, required: true },
  lifecycleState: { type: String, enum: ["ACTIVE", "COMPLETED", "UNRESOLVED"], default: "UNRESOLVED", required: true },
  occurredAt: { type: Date, required: true },
  carrierReference: { type: String, default: "" },
  returnDetails: { type: mongoose.Schema.Types.Mixed, default: undefined },
  statusHistory: { type: [statusEventSchema], default: [] },
  revision: { type: Number, default: 0 },
}, { timestamps: true, bufferCommands: false });

schema.index({ owner: 1, originalShipment: 1, triggerEventKey: 1 }, { unique: true });
schema.index({ owner: 1, occurredAt: -1 });
schema.index({ owner: 1, returnShipment: 1 });
schema.index({ owner: 1, originalWaybill: 1 });
schema.index({ owner: 1, originalWaybill: 1 }, { name: "owner_rto_waybill_casefold", collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, originalReference: 1 }, { collation: { locale: "en", strength: 2 } });

module.exports = mongoose.model("RtoRecord", schema);
