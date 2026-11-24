const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config({ quiet: true });

const app = express();
app.disable("x-powered-by");

const { corsOptions } = require("./utils/httpSecurity");
app.use(cors(corsOptions()));

const { createRequestLogger } = require("./utils/requestLogging");
app.use(createRequestLogger());
let indexesReady = false;
app.get("/health/live", (_req, res) => res.json({ status: "live" }));
app.get("/health/ready", (_req, res) => {
  const ready = indexesReady && mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "unavailable" });
});
app.use(express.json());

// Routes
const authRoutes = require("./route/authroutes");
app.use("/api/auth", authRoutes);

const { requireActiveAccount } = require("./utils/requireSession");
app.use("/api", requireActiveAccount(require("./model/model")));

// Permission checks run at the API boundary so they cannot be bypassed by
// hiding frontend navigation or mounting a route module differently.
const { createRbacAuthorization } = require("./utils/rbacAuthorization");
app.use("/api", createRbacAuthorization());

const BusinessAuditEvent = require("./model/businessAuditEvent");
const { createBusinessAuditMiddleware } = require("./utils/businessAudit");
app.use("/api", createBusinessAuditMiddleware({ AuditModel: BusinessAuditEvent }));

const createBusinessAuditRoutes = require("./route/businessAuditRoutes");
app.use("/api/audit", createBusinessAuditRoutes({ AuditModel: BusinessAuditEvent }));

const operationalSearchRoutes = require("./route/operationalSearchRoutes");
app.use("/api/search", operationalSearchRoutes());

const createDirectBookingConfigurationRoutes = require("./route/directBookingConfigurationRoutes");
app.use("/api/config", createDirectBookingConfigurationRoutes());

const createRbacRoutes = require("./route/rbacRoutes");
app.use("/api/admin/rbac", createRbacRoutes());
if (["development", "test"].includes(String(process.env.NODE_ENV || "").trim().toLowerCase())) {
  const createPickupDiagnosticRoutes = require("./route/pickupDiagnosticRoutes");
  app.use("/api/admin/pickup-diagnostics", createPickupDiagnosticRoutes({ PickupRequest: require("./model/pickupRequest") }));
}

const delhiveryRoutes = require("./route/delhiveryroutes");
app.use("/api/delhivery", delhiveryRoutes);

const reportRoutes = require("./route/reportRoutes");
app.use("/api/reports", reportRoutes);

const customerRoutes = require("./route/customerRoutes");
app.use("/api/customers", customerRoutes);

const savedPartyAddressRoutes = require("./route/savedPartyAddressRoutes");
app.use("/api/party-addresses", savedPartyAddressRoutes);
app.use("/api/products", require("./route/productRoutes"));

const customerRateCardRoutes = require("./route/customerRateCardRoutes");
app.use("/api/rate-cards", customerRateCardRoutes);

const Customer = require('./model/customer');
const Shipment = require('./model/appShipment');
const CreditCustomerInvoice = require('./model/creditCustomerInvoice');
const CustomerPayment = require('./model/customerPayment');
const createCreditCustomerBillingRoutes = require('./route/creditCustomerBillingRoutes');
app.use('/api/billing', createCreditCustomerBillingRoutes({ Customer, Shipment, Invoice: CreditCustomerInvoice, Payment: CustomerPayment, mongooseInstance: mongoose }));
const createProfitabilityReportRoutes = require('./route/profitabilityReportRoutes');
app.use('/api/finance', createProfitabilityReportRoutes({ Shipment, Invoice: CreditCustomerInvoice }));

app.use((error, req, res, next) => {
  if (res.headersSent) { res.end(); return; }
  if (error?.type === "entity.parse.failed") return res.status(400).json({ success: false, message: "Invalid JSON body." });
  if (error?.type === "entity.too.large") return res.status(413).json({ success: false, message: "Request body is too large." });
  return res.status(500).json({ success: false, message: "The request could not be completed." });
});

const SENSITIVE_STARTUP_KEY = /password|token|secret|authorization|credential|uri|email|phone|address|cookie|keyvalue|value/i;
function sanitizeStartupValue(value, key = "", depth = 0) {
  if (depth > 2 || SENSITIVE_STARTUP_KEY.test(key)) return "<redacted>";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 12)}…<redacted>` : value
    .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "<redacted>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>")
    .replace(/bearer\s+[A-Z0-9._~-]+/gi, "Bearer <redacted>")
    .replace(/\b\d{10,}\b/g, "<redacted-number>");
  if (Array.isArray(value)) return value.slice(0, 10).map(item => sanitizeStartupValue(item, key, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 20).map(([childKey, childValue]) => [childKey, sanitizeStartupValue(childValue, childKey, depth + 1)]));
  return String(value);
}

function startupDiagnostic(error, modelName) {
  const cause = error?.cause || error;
  const diagnostic = {
    model: modelName || "unknown",
    errorName: String(cause?.name || "Error").slice(0, 80),
    code: String(cause?.code || "DATABASE_NOT_READY").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40),
    collection: sanitizeStartupValue(cause?.collection || cause?.ns),
    index: sanitizeStartupValue(cause?.index || cause?.indexName),
    keyPattern: sanitizeStartupValue(cause?.keyPattern),
    keyValue: sanitizeStartupValue(cause?.keyValue, "keyValue"),
  };
  if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
    diagnostic.message = sanitizeStartupValue(cause?.message || "Startup model initialization failed");
    diagnostic.stack = sanitizeStartupValue(cause?.stack || error?.stack || "");
  } else {
    diagnostic.message = "Database model initialization failed.";
  }
  return diagnostic;
}

class StartupModelInitializationError extends Error {
  constructor(modelName, cause) {
    super("A database model failed to initialize.", { cause });
    this.name = "StartupModelInitializationError";
    this.modelName = modelName;
    this.cause = cause;
  }
}

async function initializeModels(models) {
  const results = await Promise.allSettled(models.map(async model => {
    try { await model.init(); }
    catch (error) { throw new StartupModelInitializationError(model.modelName || model.collection?.name, error); }
  }));
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
}

async function start() {
  const { readDeploymentConfiguration } = require("./utils/deploymentConfiguration");
  let configuration;
  try {
    configuration = readDeploymentConfiguration();
  } catch (error) {
    console.error(JSON.stringify({ event: "configuration.invalid", message: error.message }));
    process.exitCode = 1;
    return;
  }
  try {
    await mongoose.connect(process.env.MONGO_URI, { dbName: configuration.databaseName });
    await initializeModels(Object.values(mongoose.models));
    indexesReady = true;
    const host = process.env.HOST || (process.env.APP_DEPLOYMENT_MODE ? "0.0.0.0" : "127.0.0.1");
    const server = app.listen(configuration.port, host, () => {
      console.log(JSON.stringify({ event: "http.server", status: "LISTENING", port: configuration.port }));
      require("./route/shipmentTrackingRoutes").startPolling();
    });
    server.on("error", async () => {
      process.exitCode = 1;
      console.error(JSON.stringify({ event: "http.server", code: "LISTEN_FAILED" }));
      await mongoose.disconnect();
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "startup.failed", ...startupDiagnostic(error?.cause ? error.cause : error, error?.modelName) }));
    process.exitCode = 1;
    await mongoose.disconnect();
  }
}

module.exports = { app, initializeModels, startupDiagnostic, sanitizeStartupValue, StartupModelInitializationError };

if (require.main === module) start();


