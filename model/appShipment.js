const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  owner: { type: String, required: true },
  reference: { type: String, required: true },
  state: { type: String, enum: ["creating", "saved", "draft"], default: "creating" },
  kind: { type: String, enum: ["forward", "reverse"], default: "forward" },
  waybill: String,
  record: mongoose.Schema.Types.Mixed,
  receipt: mongoose.Schema.Types.Mixed,
  draftData: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Optional additive operational timeline; older shipment documents remain valid.
  trackingEvents: { type: [mongoose.Schema.Types.Mixed], default: undefined },
  trackingRevision: { type: Number, default: 0 },
  trackingStatus: { type: String, default: undefined },
  trackingStatusAt: { type: Date, default: undefined },
  trackingPollAttemptAt: Date,
}, { timestamps: true, bufferCommands: false });
schema.index({ owner: 1, reference: 1 }, { unique: true });
schema.index({ owner: 1, state: 1, createdAt: -1, _id: -1 });
schema.index({ owner: 1, waybill: 1 });
schema.index({ waybill: 1 }, {
  name: "uniq_assigned_waybill",
  unique: true,
  partialFilterExpression: { waybill: { $type: "string", $gt: "" } },
});
schema.index({ state: 1, trackingPollAttemptAt: 1 }, { name: "tracking_poll_candidates" });
schema.index({ owner: 1, waybill: 1 }, { name: "owner_waybill_casefold", collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, "record.name": 1 }, { collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, "record.customer": 1 }, { collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, "record.phone": 1 });
schema.index({ owner: 1, "record.pin": 1 });
schema.index({ owner: 1, "record.pincode": 1 });
module.exports = mongoose.model("AppShipment", schema);
