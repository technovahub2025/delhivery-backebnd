function handleError(res, error) {
  const configurationError = error?.code === "DELHIVERY_CONFIGURATION_ERROR";
  // Central request logging emits this bounded code with the request correlation ID.
  const invalidQuote = error?.code === "INVALID_PROVIDER_QUOTE";
  if (res.locals) res.locals.safeErrorCode = configurationError ? "DELHIVERY_CONFIGURATION_ERROR" : invalidQuote ? "INVALID_PROVIDER_QUOTE" : "PROVIDER_UPSTREAM_ERROR";

  return res.status(configurationError ? 503 : 502).json({
    success: false,
    message: configurationError ? "Shipping provider is not configured." : invalidQuote ? "Shipping provider returned no valid quotation." : "Shipping provider request failed.",
    statusCode: configurationError ? 503 : 502,
  });
}
module.exports = handleError;

function safeProviderSnapshot(value) {
  const privateValues = [process.env.DELHIVERY_API_TOKEN, process.env.JWT_SECRET, process.env.MONGO_URI]
    .map(item => item?.trim()).filter(Boolean);
  let remaining = 500;
  function visit(item, depth = 0) {
    if (--remaining < 0 || depth > 5) return "[TRUNCATED]";
    if (item == null || typeof item === "boolean" || typeof item === "number") return item;
    if (typeof item === "string") {
      let text = item;
      for (const secret of privateValues) text = text.replaceAll(secret, "[REDACTED]");
      return text.slice(0, 1000);
    }
    if (Array.isArray(item)) return item.slice(0, 25).map(child => visit(child, depth + 1));
    if (typeof item !== "object") return undefined;
    const entries = Object.entries(item).slice(0, 50).filter(([key]) =>
      !/authorization|token|secret|password|credential|api.?key/i.test(key));
    return Object.fromEntries(entries.map(([key, child]) => [key.slice(0, 100), visit(child, depth + 1)]));
  }
  const snapshot = visit(value);
  return Buffer.byteLength(JSON.stringify(snapshot) || "") <= 16 * 1024 ? snapshot : { truncated: true };
}

module.exports.safeProviderSnapshot = safeProviderSnapshot;
