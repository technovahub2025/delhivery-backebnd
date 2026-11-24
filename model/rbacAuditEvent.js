const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  actorId: { type: String, required: true },
  targetId: { type: String, default: null },
  action: { type: String, required: true, enum: ["user.role.assign", "rbac.policy.update"] },
  outcome: { type: String, required: true, enum: ["pending", "succeeded", "failed"] },
  before: { type: mongoose.Schema.Types.Mixed, default: undefined },
  after: { type: mongoose.Schema.Types.Mixed, default: undefined },
  reason: { type: String, required: true, maxlength: 500 },
}, { timestamps: true, bufferCommands: false });

schema.index({ actorId: 1, createdAt: -1 });
schema.index({ targetId: 1, createdAt: -1 });

module.exports = mongoose.model("RbacAuditEvent", schema);
