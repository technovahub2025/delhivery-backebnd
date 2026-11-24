const { test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../model/model");
const RbacPolicy = require("../model/rbacPolicy");
const auth = require("../controller/authcontroller");
const { requireActiveAccount } = require("../utils/requireSession");
const { corsOptions, createAuthRateLimit } = require("../utils/httpSecurity");

test("legacy login JWT claims remain compatible and pending users receive no role", async t => {
  const previousSecret = process.env.JWT_SECRET;
  const previousFindOne = User.findOne;
  const previousPolicyFindOne = RbacPolicy.findOne;
  process.env.JWT_SECRET = "auth-rbac-compatibility-tests-only";
  const userId = "64b000000000000000000001";
  User.findOne = async () => ({ _id: userId, name: "Existing User", email: "existing@example.test", password: await bcrypt.hash("password123", 4), roleKey: null });
  RbacPolicy.findOne = async () => null;
  t.after(() => {
    User.findOne = previousFindOne;
    RbacPolicy.findOne = previousPolicyFindOne;
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  });

  let statusCode;
  let result;
  const res = { status(value) { statusCode = value; return this; }, json(value) { result = value; return this; } };
  await auth.login({ body: { email: "existing@example.test", password: "password123" } }, res);
  assert.equal(statusCode, 200);
  assert.equal(result.user.role, null);
  assert.deepEqual(result.user.permissions, []);
  assert.equal(result.user.authorizationStatus, "pending");
  const claims = jwt.verify(result.token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  assert.equal(claims.id, userId);
  assert.equal(claims.email, "existing@example.test");
  assert.ok(claims.exp);
  assert.equal(Object.hasOwn(claims, "role"), false);
  assert.equal(Object.hasOwn(claims, "permissions"), false);
});

test("new user schema defaults to no assigned role", () => {
  assert.equal(User.schema.path("roleKey").defaultValue, null);
  assert.equal(User.schema.path("authzVersion").defaultValue, 0);
  assert.equal(User.schema.path("active").defaultValue, true);
});

test("production registration defaults closed and authentication failures hide internal messages", async t => {
  const env = { ...process.env };
  const findOne = User.findOne;
  t.after(() => {
    User.findOne = findOne;
    for (const key of ["NODE_ENV", "AUTH_REGISTRATION_ENABLED", "JWT_SECRET"]) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
  });
  process.env.NODE_ENV = "production";
  delete process.env.AUTH_REGISTRATION_ENABLED;
  process.env.JWT_SECRET = "auth-rbac-compatibility-tests-only";
  User.findOne = async () => { throw new Error("private database details"); };
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  const body = { name: "Example", email: "user@example.test", password: "valid-password" };
  await auth.register({ body }, res);
  assert.equal(res.code, 403);
  process.env.AUTH_REGISTRATION_ENABLED = "true";
  await auth.register({ body }, res);
  assert.equal(res.code, 500);
  assert.equal(res.body.message, "Registration could not be completed.");
  await auth.login({ body }, res);
  assert.equal(res.code, 500);
  assert.equal(res.body.message, "Login could not be completed.");
});

test("protected API rejects a deactivated account even with a valid JWT", async t => {
  const secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "auth-test-only";
  t.after(() => { if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; });
  const token = jwt.sign({ id: "64b000000000000000000001" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  let active = false;
  const reload = requireActiveAccount({ findById: () => ({ select: () => ({ lean: async () => ({ active }) }) }) });
  const req = { method: "GET", path: "/search", get: () => "Bearer " + token };
  const rejected = await new Promise(resolve => reload(req, { set() {}, status(code) { return { json: () => resolve(code) }; } }, () => resolve(200)));
  assert.equal(rejected, 401);
  active = true;
  const accepted = await new Promise(resolve => reload(req, { set() {}, status(code) { return { json: () => resolve(code) }; } }, () => resolve(200)));
  assert.equal(accepted, 200);
});

test("CORS uses exact allowed origins and authentication rate limits reset", () => {
  const cors = corsOptions({ NODE_ENV: "production", CORS_ALLOWED_ORIGINS: "https://uat.example.test" });
  cors.origin("https://uat.example.test", (error, allowed) => assert.equal(allowed, true));
  cors.origin("https://uat.example.test.other.test", (error, allowed) => assert.equal(allowed, false));
  assert.equal(cors.credentials, undefined);
  let time = 0;
  const middleware = createAuthRateLimit({ now: () => time, attempts: 1, windowMs: 10_000 });
  const res = { set() {}, status(code) { this.code = code; return this; }, json() {} };
  const req = { ip: "127.0.0.1" };
  let passed = 0;
  const next = () => passed++;
  middleware(req, res, next);
  middleware(req, res, next);
  assert.equal(res.code, 429);
  assert.equal(passed, 1);
  time = 10_000;
  middleware(req, res, next);
  assert.equal(passed, 2);
});
