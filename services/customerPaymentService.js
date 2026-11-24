const mongoose = require("mongoose");
const { BillingError, plainDecimal, addDecimals, subtractDecimals } = require("./creditCustomerBillingService");
const { isMockCourierAdapterEnabled } = require("../utils/mockEnvironment");

function dateValue(value, fallback) {
  const date = value == null || value === "" ? new Date(fallback) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function customerSnapshot(customer) {
  return {
    id: String(customer._id), category: customer.category,
    companyName: customer.companyName || "", displayName: customer.displayName || "",
    gstin: customer.gstin || "", primaryContact: customer.primaryContact || null,
    billingAddress: customer.billingAddress || null,
  };
}

function invoiceOutstanding(invoice) {
  if (invoice.outstandingAmount != null) return plainDecimal(invoice.outstandingAmount);
  return subtractDecimals(invoice.adjustedTotalAmount ?? invoice.totalAmount, invoice.paidAmount || "0");
}

function paymentStatus(paidAmount, outstandingAmount) {
  return plainDecimal(outstandingAmount) === "0" ? "PAID" : plainDecimal(paidAmount) === "0" ? "GENERATED" : "PARTIALLY_PAID";
}

async function execute(query) {
  if (query?.lean) query = query.lean();
  return await query;
}

function createCustomerPaymentService({ Customer, Invoice, Payment, Shipment, mongooseInstance = mongoose, now = () => new Date(), environment = process.env }) {
  const findOne = async (Model, filter, session) => {
    let query = Model.findOne(filter);
    if (session && query?.session) query = query.session(session);
    return execute(query);
  };
  const findMany = async (Model, filter, session, sort) => {
    let query = Model.find(filter);
    if (session && query?.session) query = query.session(session);
    if (sort && query?.sort) query = query.sort(sort);
    return execute(query);
  };

  async function getCustomer(owner, customerId, session) {
    if (!mongooseInstance.isValidObjectId(customerId)) throw new BillingError("customerId must be a valid customer ID.");
    const customer = await findOne(Customer, { _id: customerId, owner, category: "CREDIT" }, session);
    if (!customer) throw new BillingError("Credit customer not found.", { status: 404, code: "CREDIT_CUSTOMER_NOT_FOUND" });
    return customer;
  }

  async function invoiceViews(owner, { customerId, status } = {}) {
    const filter = { owner };
    if (customerId) {
      if (!mongooseInstance.isValidObjectId(customerId)) throw new BillingError("customerId must be a valid customer ID.");
      filter.customerId = customerId;
    }
    const rows = await findMany(Invoice, filter, null, { invoiceDate: -1, createdAt: -1, _id: -1 });
    return rows.map(row => {
      const paidAmount = plainDecimal(row.paidAmount || "0");
      const outstandingAmount = invoiceOutstanding(row);
      return { ...row, totalAmount: row.adjustedTotalAmount ?? row.totalAmount, paidAmount, outstandingAmount, status: paymentStatus(paidAmount, outstandingAmount) };
    }).filter(row => !status || row.status === status);
  }

  async function outstanding(owner, customerId) {
    const customer = await getCustomer(owner, customerId);
    const invoices = await invoiceViews(owner, { customerId: String(customer._id) });
    const open = invoices.filter(invoice => invoice.status !== "PAID");
    const total = addDecimals(open.map(invoice => invoice.outstandingAmount));
    const currencySet = new Set(open.map(invoice => invoice.currency));
    return {
      customer: customerSnapshot(customer),
      invoices: open.map(invoice => ({ id: String(invoice._id), invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.invoiceDate, dueDate: invoice.dueDate || null, status: invoice.status, currency: invoice.currency, totalAmount: plainDecimal(invoice.totalAmount), paidAmount: invoice.paidAmount, outstandingAmount: invoice.outstandingAmount })),
      totalOutstanding: currencySet.size <= 1 ? total : null,
      currency: currencySet.size === 1 ? [...currencySet][0] : null,
      mixedCurrencies: currencySet.size > 1,
    };
  }

  async function adjustInvoice({ owner, invoiceId, kind, amount: rawAmount, reason, idempotencyKey }) {
    const amount = plainDecimal(rawAmount);
    if (!mongooseInstance.isValidObjectId(invoiceId) || !["DEBIT", "CREDIT"].includes(kind) || !amount || amount === "0" ||
      typeof reason !== "string" || !reason.trim() || reason.trim().length > 160 ||
      typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,120}$/.test(idempotencyKey)) {
      throw new BillingError("Enter a valid invoice, adjustment type, positive amount, reason and request key.");
    }
    const filter = { _id: invoiceId, owner };
    const invoice = await findOne(Invoice, filter);
    if (!invoice) throw new BillingError("Invoice not found.", { status: 404, code: "INVOICE_NOT_FOUND" });
    const remaining = invoiceOutstanding(invoice);
    const paid = plainDecimal(invoice.paidAmount ?? "0");
    const total = plainDecimal(invoice.adjustedTotalAmount ?? invoice.totalAmount);
    if (remaining == null || paid == null || total == null || addDecimals([remaining, paid]) !== total) {
      throw new BillingError("Invoice balances require reconciliation.", { status: 409, code: "INVOICE_BALANCE_CONFLICT" });
    }
    const outstandingAmount = kind === "DEBIT" ? addDecimals([remaining, amount]) : subtractDecimals(remaining, amount);
    if (outstandingAmount == null || outstandingAmount.startsWith("-")) throw new BillingError("Credit cannot exceed the unpaid balance.", { status: 409, code: "OVER_ADJUSTMENT" });
    const adjustedTotalAmount = addDecimals([outstandingAmount, paid]);
    const updated = await execute(Invoice.findOneAndUpdate({
      ...filter,
      "adjustments.idempotencyKey": { $ne: idempotencyKey },
      outstandingAmount: invoice.outstandingAmount ?? { $exists: false },
      paidAmount: invoice.paidAmount ?? { $exists: false },
    }, {
      $set: { adjustedTotalAmount, outstandingAmount, status: paymentStatus(paid, outstandingAmount) },
      $push: { adjustments: { kind, amount, reason: reason.trim(), idempotencyKey, actor: owner, at: now() } },
    }, { new: true, runValidators: true }));
    if (!updated) throw new BillingError("The invoice changed or this adjustment was already recorded. Reload it before retrying.", { status: 409, code: "INVOICE_BALANCE_CONFLICT" });
    return updated;
  }

  function demoWalkInMethods() {
    const enabled = isMockCourierAdapterEnabled({
      nodeEnv: environment.NODE_ENV, deploymentMode: environment.APP_DEPLOYMENT_MODE, enabled: environment.MOCK_COURIER_ADAPTER_ENABLED,
      databaseName: mongooseInstance.connection?.readyState === 1 ? mongooseInstance.connection.name : null,
    });
    if (!enabled) return [];
    return parseMethods(environment.DEMO_WALK_IN_PAYMENT_METHODS || "CASH,UPI");
  }

  function demoWalkInAvailable() {
    return demoWalkInMethods().length > 0;
  }

  const parseMethods = raw => [...new Set(String(raw || "").split(",").map(value => value.trim().toUpperCase())
    .filter(value => /^[A-Z][A-Z0-9 _-]{0,29}$/.test(value)))].slice(0, 12);
  const paymentMethods = demo => demo ? demoWalkInMethods() : parseMethods(environment.WALK_IN_RECEIPT_METHODS);
  const walkInFilter = (owner, demo) => ({ owner, state: "saved", kind: "forward", "record.mockOnly": demo ? true : { $ne: true },
    "record.customerSnapshot.category": "WALK_IN" });

  function walkInView(row, demo) {
    const record = row.record;
    const mode = record.customerSellingPriceSnapshot?.customerSelling?.[String(record.mode || "").toUpperCase()];
    const amount = plainDecimal(mode?.sellingPrice);
    if (!amount || !/^[A-Z]{3}$/.test(mode?.currency || "") || (!demo && (mode.status !== "READY" || amount === "0"))) return null;
    return { id: String(row._id), reference: row.reference, amount, currency: mode.currency,
      receipt: (demo ? record.demoWalkInReceipt : record.walkInReceipt) || null };
  }

  async function listWalkIn(owner, demo) {
    const methods = paymentMethods(demo);
    if (!methods.length) return { methods, shipments: [] };
    const rows = await Shipment.find(walkInFilter(owner, demo)).sort({ createdAt: -1 }).limit(100).lean();
    return { methods, shipments: rows.map(row => walkInView(row, demo)).filter(Boolean) };
  }

  async function recordWalkIn({ owner, shipmentId, method, demo, reference }) {
    if (!paymentMethods(demo).includes(method)) throw new BillingError("The selected walk-in receipt method is unavailable.", { status: 409, code: demo ? "DEMO_PAYMENT_UNAVAILABLE" : "WALK_IN_RECEIPT_UNAVAILABLE" });
    if (!demo && (typeof reference !== "string" || !reference.trim() || reference.length > 160)) {
      throw new BillingError("Enter a reference for the payment already received.");
    }
    if (!mongooseInstance.isValidObjectId(shipmentId)) throw new BillingError("Provide a valid shipment ID.");
    const filter = { ...walkInFilter(owner, demo), _id: shipmentId };
    const row = await findOne(Shipment, filter);
    if (!row) throw new BillingError("Walk-in shipment not found.", { status: 404, code: demo ? "DEMO_SHIPMENT_NOT_FOUND" : "WALK_IN_SHIPMENT_NOT_FOUND" });
    const view = walkInView(row, demo);
    if (!view) throw new BillingError("This shipment has no usable historical selling price.");
    if (view.receipt) return view.receipt;
    const field = demo ? "demoWalkInReceipt" : "walkInReceipt";
    const path = `record.${field}`;
    const receipt = { amount: view.amount, currency: view.currency, method, source: demo ? "DEMO_ONLY" : "MANUAL_RECEIPT",
      ...(demo ? {} : { reference: reference.trim() }), at: now(), actor: owner };
    const result = await Shipment.updateOne({ ...filter, [path]: { $exists: false } }, { $set: { [path]: receipt } });
    if (result.modifiedCount === 1) return receipt;
    const existing = await findOne(Shipment, filter);
    if (existing?.record?.[field]) return existing.record[field];
    throw new BillingError("The shipment changed. Reload it before trying again.", { status: 409, code: demo ? "DEMO_PAYMENT_CONFLICT" : "WALK_IN_RECEIPT_CONFLICT" });
  }

  async function record({ owner, actor, customerId, amount: rawAmount, currency, receivedAt, reference = "", idempotencyKey, allocations, correlationId }) {
    const amount = plainDecimal(rawAmount);
    const normalizedKey = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
    const normalizedCurrency = typeof currency === "string" ? currency.trim().toUpperCase() : "";
    if (!amount || amount === "0") throw new BillingError("Payment amount must be a positive decimal amount.");
    if (!normalizedKey || normalizedKey.length > 120) throw new BillingError("A unique idempotency key is required.");
    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) throw new BillingError("A three-letter payment currency is required.");
    if (typeof reference !== "string" || reference.length > 160) throw new BillingError("Payment reference must be 160 characters or fewer.");
    if (!Array.isArray(allocations) || allocations.length < 1 || allocations.length > 50) throw new BillingError("Provide between one and 50 invoice allocations.");
    const date = dateValue(receivedAt, now());
    if (!date) throw new BillingError("receivedAt must be a valid date.");
    const seen = new Set();
    const normalizedAllocations = [];
    for (const item of allocations) {
      if (!item || !mongooseInstance.isValidObjectId(item.invoiceId)) throw new BillingError("Each allocation requires a valid invoice ID.");
      const invoiceId = String(item.invoiceId);
      if (seen.has(invoiceId)) throw new BillingError("An invoice may appear only once in a payment allocation.");
      seen.add(invoiceId);
      const allocationAmount = plainDecimal(item.amount);
      if (!allocationAmount || allocationAmount === "0") throw new BillingError("Allocation amounts must be positive decimal amounts.");
      normalizedAllocations.push({ invoiceId, amount: allocationAmount });
    }
    if (addDecimals(normalizedAllocations.map(item => item.amount)) !== amount) throw new BillingError("Payment amount must exactly equal the sum of its invoice allocations.");
    if (!mongooseInstance.startSession) throw new BillingError("MongoDB transactions are required for safe payment allocation.", { status: 503, code: "PAYMENT_TRANSACTION_UNAVAILABLE" });

    let session;
    try {
      session = await mongooseInstance.startSession();
      if (Payment.init) await Payment.init();
      if (Invoice.init) await Invoice.init();
      let saved;
      await session.withTransaction(async () => {
        const duplicate = await findOne(Payment, { owner, idempotencyKey: normalizedKey }, session);
        if (duplicate) throw new BillingError("This payment request has already been recorded.", { status: 409, code: "DUPLICATE_PAYMENT" });
        const customer = await getCustomer(owner, customerId, session);
        const invoices = [];
        for (const allocation of normalizedAllocations) {
          const invoice = await findOne(Invoice, { _id: allocation.invoiceId, owner, customerId: customer._id }, session);
          if (!invoice) throw new BillingError("An allocated invoice was not found for this customer and account.", { status: 404, code: "INVOICE_NOT_FOUND" });
          if (invoice.currency !== normalizedCurrency) throw new BillingError("Payment currency must match every allocated invoice currency.");
          const remaining = invoiceOutstanding(invoice);
          if (remaining == null || remaining === "0") throw new BillingError("A fully paid invoice cannot receive another allocation.", { status: 409, code: "INVOICE_ALREADY_PAID" });
          if (plainDecimal(allocation.amount) == null || subtractDecimals(remaining, allocation.amount).startsWith("-")) throw new BillingError("Allocation exceeds the invoice outstanding balance.", { status: 409, code: "OVER_ALLOCATION" });
          invoices.push({ invoice, allocation, remaining });
        }

        const paymentData = {
          owner, customerId: customer._id, customerSnapshot: customerSnapshot(customer), idempotencyKey: normalizedKey,
          amount, currency: normalizedCurrency, receivedAt: date, reference: reference.trim(),
          allocations: normalizedAllocations.map(item => {
            const found = invoices.find(row => String(row.invoice._id) === item.invoiceId);
            return { invoiceId: found.invoice._id, invoiceNumber: found.invoice.invoiceNumber, amount: item.amount, currency: normalizedCurrency };
          }),
          auditTrail: [{ action: "RECORDED", actor: String(actor), at: new Date(now()), ...(correlationId ? { correlationId: String(correlationId).slice(0, 100) } : {}) }],
        };
        const created = await Payment.create([paymentData], { session });
        saved = created[0];

        for (const { invoice, allocation, remaining } of invoices) {
          const paidAmount = addDecimals([invoice.paidAmount || "0", allocation.amount]);
          const outstandingAmount = subtractDecimals(remaining, allocation.amount);
          if (paidAmount == null || outstandingAmount == null || outstandingAmount.startsWith("-")) throw new BillingError("Invoice balances could not be represented safely.", { status: 409, code: "INVOICE_BALANCE_CONFLICT" });
          const status = paymentStatus(paidAmount, outstandingAmount);
          const balanceGuard = {
            outstandingAmount: invoice.outstandingAmount == null ? { $exists: false } : invoice.outstandingAmount,
            paidAmount: invoice.paidAmount == null ? { $exists: false } : invoice.paidAmount,
          };
          const result = await Invoice.updateOne(
            { _id: invoice._id, owner, customerId: customer._id, ...balanceGuard },
            { $set: { paidAmount, outstandingAmount, status }, $push: {
              paymentHistory: { paymentId: saved._id, amount: allocation.amount, recordedAt: date },
              auditTrail: { action: status === "PAID" ? "PAID" : status === "PARTIALLY_PAID" ? "PARTIALLY_PAID" : "PAYMENT_ALLOCATED", actor: String(actor), at: new Date(now()), ...(correlationId ? { correlationId: String(correlationId).slice(0, 100) } : {}) },
            } }, { session, runValidators: true }
          );
          if (result?.matchedCount === 0 || result?.n === 0) throw new BillingError("Invoice changed during allocation; retry after reloading balances.", { status: 409, code: "INVOICE_BALANCE_CONFLICT" });
        }

        const customerInvoices = await findMany(Invoice, { owner, customerId: customer._id }, session);
        const outstandingAmounts = customerInvoices.map(invoice => invoiceOutstanding(invoice)).filter(value => value != null && value !== "0");
        const balance = addDecimals(outstandingAmounts);
        if (balance == null) throw new BillingError("Customer outstanding balance could not be represented safely.", { status: 409, code: "BALANCE_CALCULATION_FAILED" });
        await Customer.updateOne({ _id: customer._id, owner, category: "CREDIT" }, { $set: { outstandingBalanceExact: balance, outstandingBalance: Number(balance) } }, { session, runValidators: true });
      });
      return saved;
    } catch (error) {
      if (error?.code === 11000) throw new BillingError("This payment or allocation has already been recorded.", { status: 409, code: "DUPLICATE_PAYMENT" });
      throw error;
    } finally { if (session) await session.endSession(); }
  }

  async function listPayments(owner, { customerId } = {}) {
    const filter = { owner };
    if (customerId) {
      if (!mongooseInstance.isValidObjectId(customerId)) throw new BillingError("customerId must be a valid customer ID.");
      filter.customerId = customerId;
    }
    return findMany(Payment, filter, null, { receivedAt: -1, createdAt: -1, _id: -1 });
  }

  async function getPayment(owner, id) {
    if (!mongooseInstance.isValidObjectId(id)) throw new BillingError("Invalid payment ID.");
    return findOne(Payment, { _id: id, owner });
  }

  return { invoiceViews, outstanding, record, listPayments, getPayment, adjustInvoice, listWalkIn, recordWalkIn, demoWalkInAvailable };
}

module.exports = { invoiceOutstanding, paymentStatus, createCustomerPaymentService };
