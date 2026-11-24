function corsOptions(environment = process.env) {
  const origins = new Set((environment.CORS_ALLOWED_ORIGINS || "").split(",").map(origin => origin.trim()).filter(Boolean));
  if (!environment.CORS_ALLOWED_ORIGINS && ["development", "test"].includes(environment.NODE_ENV)) {
    origins.add("http://localhost:5173");
    origins.add("http://127.0.0.1:5173");
  }
  return {
    origin(origin, callback) { callback(null, Boolean(origin && origins.has(origin))); },
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Content-Disposition"],
  };
}

function createAuthRateLimit({ now = Date.now, attempts = 20, windowMs = 15 * 60_000, maxClients = 10_000 } = {}) {
  const clients = new Map();
  let nextCleanup = 0;
  return (req, res, next) => {
    const time = now();
    if (time >= nextCleanup) {
      for (const [ip, entry] of clients) if (entry.until <= time) clients.delete(ip);
      nextCleanup = time + windowMs;
    }
    const ip = req.ip;
    let entry = clients.get(ip);
    if (!entry && clients.size >= maxClients) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((nextCleanup - time) / 1000))));
      return res.status(429).json({ success: false, message: "Too many authentication attempts. Try again later." });
    }
    if (!entry || entry.until <= time) {
      entry = { count: 0, until: time + windowMs };
      clients.set(ip, entry);
    }
    if (++entry.count <= attempts) return next();
    res.set("Retry-After", String(Math.max(1, Math.ceil((entry.until - time) / 1000))));
    return res.status(429).json({ success: false, message: "Too many authentication attempts. Try again later." });
  };
}

module.exports = { corsOptions, createAuthRateLimit };
