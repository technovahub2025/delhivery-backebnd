const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  ownerId: { type: String, required: true },
  actorId: { type: String, required: true },
  action: { type: String, required: true, maxlength: 80 },
  entityType: { type: String, required: true, maxlength: 40 },
  entityRef: { type: String, default: null, maxlength: 160 },
  outcome: { type: String, enum: ["SUCCEEDED", "FAILED", "UNCONFIRMED"], required: true },
  statusCode: { type: Number, required: true, min: 100, max: 599 },
  changedFields: { type: [String], default: [] },
  correlationId: { type: String, default: null, maxlength: 100 },
  idempotencyKey: { type: String, default: undefined, maxlength: 160 },
  // Optional only: records are retained indefinitely unless an operator
  // supplies an approved retention interval.
  expiresAt: { type: Date, default: undefined },
}, { timestamps: true, bufferCommands: false, strict: true });

schema.index({ ownerId: 1, createdAt: -1, _id: -1 });
schema.index({ ownerId: 1, entityType: 1, entityRef: 1, createdAt: -1 });
schema.index({ ownerId: 1, action: 1, idempotencyKey: 1, outcome: 1 }, {
  unique: true,
  partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
  name: "uniq_owner_audit_operation_outcome",
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("BusinessAuditEvent", schema);
