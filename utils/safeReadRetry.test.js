const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SAFE_READ_RETRY_POLICIES, isRetryableReadFailure, withSafeReadRetry, singleFlight } = require("./safeReadRetry");

test("safe read retries are bounded and use exponential backoff", async () => {
  let attempts = 0;
  const waits = [];
  const value = await withSafeReadRetry(async () => {
    attempts += 1;
    if (attempts < 3) { const error = new Error("transient"); error.status = 503; throw error; }
    return "ok";
  }, { policy: "trackingSync", sleep: async ms => waits.push(ms), random: () => 0.5 });
  assert.equal(value, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [150, 300]);
  assert.equal(SAFE_READ_RETRY_POLICIES.providerQuote.maxAttempts, 2);
});

test("definitive failures and ambiguous non-read operations are never retried", async () => {
  let attempts = 0;
  const rejected = Object.assign(new Error("rejected"), { status: 422, definitive: true, outcome: "REJECTED" });
  await assert.rejects(withSafeReadRetry(async () => { attempts += 1; throw rejected; }, { sleep: async () => assert.fail("must not wait") }), rejected);
  assert.equal(attempts, 1);
  assert.equal(isRetryableReadFailure(Object.assign(new Error(), { code: "ECONNRESET" })), true);
  assert.equal(isRetryableReadFailure(Object.assign(new Error(), { status: 400 })), false);
  assert.equal(isRetryableReadFailure(Object.assign(new Error(), { retryable: true, definitive: true })), false);
});

test("retry limit is enforced and concurrent operations share one in-flight attempt", async () => {
  let attempts = 0;
  await assert.rejects(withSafeReadRetry(async () => { attempts += 1; throw Object.assign(new Error("busy"), { status: 429 }); }, { policy: "providerQuote", sleep: async () => {}, random: () => 0.5 }), /busy/);
  assert.equal(attempts, 2);

  let calls = 0;
  let release;
  const operation = () => { calls += 1; return new Promise(resolve => { release = resolve; }); };
  const left = singleFlight("test-concurrent-key", operation);
  const right = singleFlight("test-concurrent-key", operation);
  await Promise.resolve();
  assert.equal(calls, 1);
  release("shared");
  assert.deepEqual(await Promise.all([left, right]), ["shared", "shared"]);
});
