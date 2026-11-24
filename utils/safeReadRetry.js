const SAFE_READ_RETRY_POLICIES = Object.freeze({
  bookingReconciliation: Object.freeze({ maxAttempts: 3, baseDelayMs: 150, maxDelayMs: 1200 }),
  trackingSync: Object.freeze({ maxAttempts: 3, baseDelayMs: 150, maxDelayMs: 1200 }),
  pickupSync: Object.freeze({ maxAttempts: 3, baseDelayMs: 150, maxDelayMs: 1200 }),
  providerQuote: Object.freeze({ maxAttempts: 2, baseDelayMs: 150, maxDelayMs: 600 }),
  providerRead: Object.freeze({ maxAttempts: 3, baseDelayMs: 150, maxDelayMs: 1200 }),
});

const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ECONNABORTED"]);

function isRetryableReadFailure(error) {
  const status = Number(error?.response?.status ?? error?.status);
  if ([408, 425, 429].includes(status) || (status >= 500 && status <= 599)) return true;
  if (RETRYABLE_CODES.has(String(error?.code || "").toUpperCase())) return true;
  return error?.retryable === true && error?.definitive !== true && error?.outcome !== "REJECTED";
}

async function withSafeReadRetry(operation, { policy = "providerRead", shouldRetry = isRetryableReadFailure, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random } = {}) {
  if (typeof operation !== "function") throw new TypeError("A read-only operation is required.");
  const limits = SAFE_READ_RETRY_POLICIES[policy];
  if (!limits) throw new TypeError("Unknown safe read retry policy.");
  let attempt = 0;
  while (true) {
    attempt += 1;
    try { return await operation(); }
    catch (error) {
      if (attempt >= limits.maxAttempts || !shouldRetry(error)) throw error;
      const exponential = Math.min(limits.maxDelayMs, limits.baseDelayMs * (2 ** (attempt - 1)));
      await sleep(Math.round(exponential * (0.8 + (Math.max(0, Math.min(1, Number(random()) || 0)) * 0.4))));
    }
  }
}

const inFlight = new Map();
function singleFlight(key, operation) {
  const normalizedKey = String(key || "");
  if (!normalizedKey || typeof operation !== "function") throw new TypeError("A key and operation are required.");
  if (inFlight.has(normalizedKey)) return inFlight.get(normalizedKey);
  const pending = Promise.resolve().then(operation);
  inFlight.set(normalizedKey, pending);
  pending.finally(() => { if (inFlight.get(normalizedKey) === pending) inFlight.delete(normalizedKey); }).catch(() => {});
  return pending;
}

module.exports = { SAFE_READ_RETRY_POLICIES, isRetryableReadFailure, withSafeReadRetry, singleFlight };
