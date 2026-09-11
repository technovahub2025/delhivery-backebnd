const mongoose = require("mongoose");

const delhiveryWebhookSchema = new mongoose.Schema(
  {
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

module.exports = mongoose.model("DelhiveryWebhook", delhiveryWebhookSchema);
