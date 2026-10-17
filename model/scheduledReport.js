const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  owner: { type: String, required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  type: {
    type: String,
    required: true,
    enum: ["Orders", "NDR", "Exceptions NDR"],
  },
  recipient: { type: String, required: true, trim: true, lowercase: true },
  recurrence: {
    type: String,
    required: true,
    enum: ["Daily", "Weekly", "Monthly"],
  },
  status: {
    type: [{ type: String, enum: ["Manifested", "In Transit", "Delivered", "Cancelled"] }],
    default: [],
  },
  subStatus: {
    type: [{ type: String, enum: ["COD", "Prepaid", "Pending Pickup", "RTO"] }],
    default: [],
  },
  enabled: { type: Boolean, default: false },
}, { timestamps: true, bufferCommands: false });

schema.index({ owner: 1, createdAt: -1 });

module.exports = mongoose.model("ScheduledReport", schema);
