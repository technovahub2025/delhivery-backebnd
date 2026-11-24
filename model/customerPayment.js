const mongoose = require("mongoose");

const allocationSchema = new mongoose.Schema({
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "CreditCustomerInvoice", required: true },
  invoiceNumber: { type: String, required: true },
  amount: { type: mongoose.Schema.Types.Decimal128, required: true },
  currency: { type: String, required: true, maxlength: 3 },
}, { _id: false, strict: true });

const schema = new mongoose.Schema({
  owner: { type: String, required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
  customerSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  idempotencyKey: { type: String, required: true, trim: true, maxlength: 120 },
  amount: { type: mongoose.Schema.Types.Decimal128, required: true },
  currency: { type: String, required: true, maxlength: 3 },
  receivedAt: { type: Date, required: true },
  reference: { type: String, trim: true, maxlength: 160, default: "" },
  allocations: { type: [allocationSchema], required: true, validate: { validator: rows => rows.length > 0, message: "At least one invoice allocation is required." } },
  auditTrail: { type: [new mongoose.Schema({ action: { type: String, required: true, enum: ["RECORDED"] }, actor: { type: String, required: true }, at: { type: Date, required: true }, correlationId: { type: String, maxlength: 100, default: undefined } }, { _id: false, strict: true })], required: true },
}, { timestamps: true, bufferCommands: false, strict: true, immutable: true });

schema.index({ owner: 1, idempotencyKey: 1 }, { unique: true, name: "uniq_owner_payment_idempotency" });
schema.index({ owner: 1, customerId: 1, receivedAt: -1, _id: -1 });
schema.index({ owner: 1, "allocations.invoiceId": 1 });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "findOneAndRemove"]) {
  schema.pre(operation, function rejectPaymentMutation() {
    throw new Error("Payment records are immutable; record a separate adjustment workflow when one is defined.");
  });
}

module.exports = mongoose.model("CustomerPayment", schema);
