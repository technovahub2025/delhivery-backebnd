const jwt = require("jsonwebtoken");
module.exports = function requireSession(req, res, next) {
  res.set("Cache-Control", "no-store");
  const bearer = /^Bearer (\S+)$/i.exec(req.get("Authorization") || "");
  if (!bearer) return res.status(401).json({ success: false, message: "Login required." });
  if (!process.env.JWT_SECRET) return res.status(503).json({ success: false, message: "Authentication is not configured." });
  try {
    const user = jwt.verify(bearer[1], process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (typeof user.id !== "string" || !user.id || !user.exp) throw new Error();
    req.user = user;
  } catch {
    return res.status(401).json({ success: false, message: "Session expired or invalid. Please log in again." });
  }
  next();
};
