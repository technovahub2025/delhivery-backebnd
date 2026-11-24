const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: "active" },
  revision: { type: Number, required: true, min: 1 },
  roles: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedBy: { type: String, required: true },
}, { timestamps: true, bufferCommands: false });

module.exports = mongoose.model("RbacPolicy", schema);
