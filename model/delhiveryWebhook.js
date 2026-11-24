const mongoose = require("mongoose");

const delhiveryWebhookSchema = new mongoose.Schema(
  {
    owner: { type: String, default: undefined, index: true },
    providerCode: { type: String, default: "" },
    archiveKey: String,
    // Keep the original payload because webhook fields may vary by event.
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  {
    timestamps: true,
    minimize: false,
  }
);
delhiveryWebhookSchema.index({ archiveKey: 1 }, { unique: true, partialFilterExpression: { archiveKey: { $type: "string" } } });
delhiveryWebhookSchema.index({ owner: 1, providerCode: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.model("DelhiveryWebhook", delhiveryWebhookSchema);
