const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  ownerId: { type: String, default: null, maxlength: 100 },
  correlationId: { type: String, default: null, maxlength: 36 },
  method: { type: String, enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], required: true },
  operationPath: { type: String, required: true, maxlength: 100 },
  outcome: { type: String, enum: ["RESPONSE", "HTTP_ERROR", "TRANSPORT_ERROR"], required: true },
  statusCode: { type: Number, min: 100, max: 599 },
  durationMs: { type: Number, min: 0, required: true },
  expiresAt: Date,
}, { timestamps: true, bufferCommands: false });

schema.index({ ownerId: 1, createdAt: -1, _id: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("DelhiveryIntegrationEvent", schema);
