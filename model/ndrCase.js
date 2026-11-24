const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  owner: { type: String, required: true, index: true },
  shipment: { type: mongoose.Schema.Types.ObjectId, ref: "AppShipment", required: true },
  waybill: { type: String, required: true },
  reference: { type: String, default: "" },
  customer: { type: String, default: "" },
  destination: { type: String, default: "" },
  payment: { type: String, default: "" },
  providerCode: { type: String, default: "" },
  reason: { type: String, required: true },
  status: { type: String, enum: ["OPEN", "ACTION_SUBMITTING", "ACTION_SUBMITTED", "ACTION_FAILED", "OUTCOME_UNCONFIRMED", "RESOLVED"], default: "OPEN" },
  occurredAt: { type: Date, required: true },
  trackingEventKey: { type: String, required: true },
  carrierDetails: { type: mongoose.Schema.Types.Mixed, default: undefined },
  actions: { type: [mongoose.Schema.Types.Mixed], default: [] },
  revision: { type: Number, default: 0 },
  resolvedAt: { type: Date, default: undefined },
}, { timestamps: true, bufferCommands: false });

schema.index({ owner: 1, shipment: 1, trackingEventKey: 1 }, { unique: true });
schema.index({ owner: 1, status: 1, occurredAt: -1 });
schema.index({ owner: 1, waybill: 1 });
schema.index({ owner: 1, waybill: 1 }, { name: "owner_ndr_waybill_casefold", collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, reference: 1 }, { collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, customer: 1 }, { collation: { locale: "en", strength: 2 } });

module.exports = mongoose.model("NdrCase", schema);
