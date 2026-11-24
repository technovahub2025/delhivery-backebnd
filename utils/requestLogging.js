const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const requestContext = new AsyncLocalStorage();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;

function correlationId(req) {
  const supplied = String(req.get?.("x-request-id") || req.headers?.["x-request-id"] || "").trim();
  return UUID.test(supplied) ? supplied : crypto.randomUUID();
}

function safeRoute(req) {
  const path = req.baseUrl && req.route?.path ? `${req.baseUrl}${req.route.path}` : req.route?.path;
  if (typeof path === "string" && path.startsWith("/")) return path.slice(0, 200);
  return "<unmatched>";
}

function safeErrorCode(res) {
  if (res.statusCode < 400) return undefined;
  const code = String(res.locals?.safeErrorCode || "").toUpperCase();
  if (SAFE_CODE.test(code)) return code;
  if (res.statusCode >= 500) return "HTTP_5XX";
  if (res.statusCode >= 400) return "HTTP_4XX";
  return undefined;
}

function createRequestLogger({ logger = console, now = () => Date.now() } = {}) {
  return function requestLogger(req, res, next) {
    const id = correlationId(req);
    const start = now();
    req.correlationId = id;
    res.setHeader("X-Request-ID", id);
    const sendJson = res.json.bind(res);
    res.json = function loggedJson(body) {
      const code = String(body?.code || "").toUpperCase();
      if (SAFE_CODE.test(code)) res.locals.safeErrorCode = code;
      return sendJson(body);
    };
    let emitted = false;
    res.once("finish", () => {
      if (emitted) return;
      emitted = true;
      const record = {
        event: "http.request",
        correlationId: id,
        method: String(req.method || "GET").toUpperCase(),
        route: safeRoute(req),
        statusCode: Number(res.statusCode) || 0,
        durationMs: Math.max(0, Number(now() - start) || 0),
        ...(typeof res.locals?.businessReferenceId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(res.locals.businessReferenceId) ? { referenceId: res.locals.businessReferenceId } : {}),
        ...(typeof res.locals?.providerReferenceId === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(res.locals.providerReferenceId) ? { providerReferenceId: res.locals.providerReferenceId } : {}),
        ...(safeErrorCode(res) ? { errorCode: safeErrorCode(res) } : {}),
      };
      const output = JSON.stringify(record);
      try {
        if (record.statusCode >= 500) logger.error(output);
        else if (record.statusCode >= 400) logger.warn(output);
        else logger.info(output);
      } catch { /* observability must never change the response or business operation */ }
    });
    requestContext.run(req, next);
  };
}

module.exports = { createRequestLogger, correlationId, safeRoute, safeErrorCode, requestContext };
