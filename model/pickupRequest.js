const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  owner: { type: String, required: true, index: true },
  carrierRequestId: { type: String, default: "" },
  carrierRequestKey: String,
  localRequestKey: String,
  localRequestFingerprint: String,
  carrierSubmissionStatus: { type: String, enum: ["SUBMITTING", "CONFIRMED", "FAILED", "OUTCOME_UNCONFIRMED"] },
  providerCode: { type: String, default: "" },
  pickupDate: { type: String, required: true },
  pickupTime: { type: String, required: true },
  pickupTimeTo: { type: String, default: null },
  instructions: { type: String, maxlength: 500, default: "" },
  shipmentCount: { type: Number, min: 0, validate: count => count == null || Number.isSafeInteger(count) },
  warehouse: { type: String, required: true },
  location: { type: mongoose.Schema.Types.Mixed, default: undefined },
  packageCount: { type: Number, required: true, min: 1 },
  totalWeightKg: { type: Number, min: 0 },
  shipmentRefs: { type: [mongoose.Schema.Types.Mixed], default: [] },
  workflow: { type: String, enum: ["CARRIER", "LOCAL"], default: "CARRIER" },
  revision: { type: Number, default: 0, min: 0 },
  history: [{
    _id: false,
    action: { type: String, required: true },
    status: { type: String, required: true },
    timestamp: { type: Date, required: true, default: Date.now },
    description: { type: String, default: "" },
    actor: { type: String, default: "" },
  }],
  status: { type: String, default: "Scheduled" },
  request: { type: mongoose.Schema.Types.Mixed, required: true },
  carrierResponse: { type: mongoose.Schema.Types.Mixed, required: true }
  ,submissionAttempt: { type: mongoose.Schema.Types.Mixed, default: undefined }
}, { timestamps: true, bufferCommands: false });

schema.index({ owner: 1, createdAt: -1 });
schema.index({ owner: 1, status: 1, pickupDate: 1, pickupTime: 1 });
schema.index({ owner: 1, carrierRequestId: 1 }, { collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, carrierRequestKey: 1 }, { unique: true, partialFilterExpression: { carrierRequestKey: { $type: "string" } } });
schema.index({ owner: 1, localRequestKey: 1 }, { unique: true, partialFilterExpression: { localRequestKey: { $type: "string" } } });
schema.index({ owner: 1, warehouse: 1 }, { collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, "shipmentRefs.waybill": 1 }, { collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, "shipmentRefs.reference": 1 }, { collation: { locale: "en", strength: 2 } });
schema.index({ owner: 1, "location.phone": 1 });
schema.index({ owner: 1, "location.pincode": 1 });

module.exports = mongoose.model("PickupRequest", schema);
