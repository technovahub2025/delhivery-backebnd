const express = require("express");
const requireSession = require("../utils/requireSession");
const { BillingError, createCreditCustomerBillingService } = require("../services/creditCustomerBillingService");
const { createCustomerPaymentService } = require("../services/customerPaymentService");

function jsonSafe(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (value?._bsontype === "Decimal128" || value?._bsontype === "ObjectId") return value.toString();
  if (value?.$__ && typeof value.toObject === "function") return jsonSafe(value.toObject());
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "__v").map(([key, item]) => [key === "_id" ? "id" : key, jsonSafe(item)]));
  return value;
}

module.exports = function createCreditCustomerBillingRoutes(dependencies) {
  const router = express.Router();
  const billing = createCreditCustomerBillingService(dependencies);
  const payments = createCustomerPaymentService(dependencies);
  router.use(requireSession);

  const run = handler => async (req, res) => {
    try { return await handler(req, res); }
    catch (error) {
      if (error instanceof BillingError) return res.status(error.status).json({ success: false, code: error.code, message: error.message, ...(error.details && { data: jsonSafe(error.details) }) });
      if (error?.code === 11000) return res.status(409).json({ success: false, code: "DUPLICATE_BILLING_RECORD", message: "This period, invoice number, or shipment has already been billed." });
      return res.status(503).json({ success: false, code: "BILLING_UNAVAILABLE", message: "Credit billing could not be completed." });
    }
  };

  router.get("/credit-customers", run(async (req, res) => {
    const customers = await billing.listCustomers(req.user.id);
    return res.json({ success: true, data: { customers: jsonSafe(customers) } });
  }));

  router.get("/eligible-shipments", run(async (req, res) => {
    const result = await billing.getEligibility(req.user.id, req.query.customerId, req.query.period);
    return res.json({ success: true, data: jsonSafe(result) });
  }));

  router.get("/invoices", run(async (req, res) => {
    const invoices = await billing.listInvoices(req.user.id, { customerId: req.query.customerId, period: req.query.period });
    return res.json({ success: true, data: { invoices: jsonSafe(invoices) } });
  }));

  router.get("/invoices/:id", run(async (req, res) => {
    const invoice = await billing.getInvoice(req.user.id, req.params.id);
    return invoice ? res.json({ success: true, data: { invoice: jsonSafe(invoice) } }) : res.status(404).json({ success: false, message: "Invoice not found." });
  }));

  router.post("/invoices/:id/adjustments", run(async (req, res) => {
    const { kind, amount, reason, idempotencyKey } = req.body || {};
    const invoice = await payments.adjustInvoice({ owner: req.user.id, invoiceId: req.params.id, kind, amount, reason, idempotencyKey });
    return res.status(201).json({ success: true, data: { invoice: jsonSafe(invoice) } });
  }));

  router.get("/walk-in-payments", run(async (req, res) => {
    const [result, manual] = await Promise.all([payments.listWalkIn(req.user.id, true), payments.listWalkIn(req.user.id, false)]);
    return res.json({ success: true, data: jsonSafe({ ...result, demoAvailable: payments.demoWalkInAvailable(), ...(manual.methods.length ? { manual } : {}) }) });
  }));

  router.post("/walk-in-payments/:shipmentId", run(async (req, res) => {
    const receipt = await payments.recordWalkIn({ owner: req.user.id, shipmentId: req.params.shipmentId, method: req.body?.method,
      demo: req.body?.source !== "MANUAL", reference: req.body?.reference });
    return res.status(201).json({ success: true, data: { receipt: jsonSafe(receipt) } });
  }));

  router.get("/payment-invoices", run(async (req, res) => {
    const invoices = await payments.invoiceViews(req.user.id, { customerId: req.query.customerId, status: req.query.status });
    return res.json({ success: true, data: { invoices: jsonSafe(invoices) } });
  }));

  router.get("/customers/:customerId/outstanding", run(async (req, res) => {
    const result = await payments.outstanding(req.user.id, req.params.customerId);
    return res.json({ success: true, data: jsonSafe(result) });
  }));

  router.get("/payments", run(async (req, res) => {
    const rows = await payments.listPayments(req.user.id, { customerId: req.query.customerId });
    return res.json({ success: true, data: { payments: jsonSafe(rows) } });
  }));

  router.get("/payments/:id", run(async (req, res) => {
    const payment = await payments.getPayment(req.user.id, req.params.id);
    return payment ? res.json({ success: true, data: { payment: jsonSafe(payment) } }) : res.status(404).json({ success: false, message: "Payment not found." });
  }));

  router.post("/payments", run(async (req, res) => {
    const { customerId, amount, currency, receivedAt, reference, idempotencyKey, allocations } = req.body || {};
    const payment = await payments.record({
      owner: req.user.id, actor: req.user.id, correlationId: req.correlationId,
      customerId, amount, currency, receivedAt, reference, idempotencyKey, allocations,
    });
    return res.status(201).json({ success: true, data: { payment: jsonSafe(payment) } });
  }));

  router.post("/invoices", run(async (req, res) => {
    const { customerId, period, invoiceNumber, invoiceDate, dueDate } = req.body || {};
    const invoice = await billing.generate({ owner: req.user.id, actor: req.user.id, customerId, period, invoiceNumber, invoiceDate, dueDate, correlationId: req.correlationId });
    return res.status(201).json({ success: true, data: { invoice: jsonSafe(invoice) } });
  }));

  return router;
};
