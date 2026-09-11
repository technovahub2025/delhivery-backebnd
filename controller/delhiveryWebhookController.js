const DelhiveryWebhook = require("../model/delhiveryWebhook");

exports.delhiveryWebhook = async (req, res) => {
  try {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "A non-empty JSON object is required",
      });
    }

    // Acknowledge only after MongoDB has saved the event.
    await DelhiveryWebhook.create({ payload: req.body });

    return res.status(200).json({
      success: true,
      message: "Webhook received successfully",
    });
  } catch (error) {
    console.error("Delhivery webhook processing failed:", error.name);

    return res.status(500).json({
      success: false,
      message: "Webhook processing failed",
    });
  }
};
