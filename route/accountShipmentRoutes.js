const router = require("express").Router();
const jwt = require("jsonwebtoken");

function requireSession(req, res, next) {
  const bearer = /^Bearer (\S+)$/i.exec(req.get("Authorization") || "");
  if (!bearer) return res.status(401).json({ success: false, message: "Login required." });
  if (!process.env.JWT_SECRET) {
    return res.status(503).json({ success: false, message: "Authentication is not configured." });
  }
  try {
    const session = jwt.verify(bearer[1], process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (!session || typeof session !== "object" || !session.id || !session.exp) throw new Error();
    req.user = session;
  } catch {
    return res.status(401).json({ success: false, message: "Session expired or invalid. Please log in again." });
  }
  next();
}

router.get("/shipments", requireSession, (req, res) => {
  res.set("Cache-Control", "no-store");
  const page = req.query.page ?? "1";
  const limit = req.query.limit ?? "100";
  if (typeof page !== "string" || !/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)) ||
      typeof limit !== "string" || !/^[1-9]\d*$/.test(limit) || Number(limit) > 100) {
    return res.status(400).json({ success: false, message: "page must be a positive integer; limit must be between 1 and 100." });
  }
  // Do not call tracking without identifiers or guess a private portal endpoint.
  // No supported account listing source has been verified for this account.
  return res.status(503).json({
    success: false,
    code: "SHIPMENT_LIST_SOURCE_REQUIRED",
    message: "Account shipment listing is not connected. Delhivery's documented tracking API requires known waybills or order IDs. Provide account-approved shipment-list API documentation and access, or a shipment CSV export from Delhivery One, to enable account history.",
  });
});

module.exports = router;
