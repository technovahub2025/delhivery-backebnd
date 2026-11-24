const { test } = require("node:test");
const assert = require("node:assert/strict");
const { initializeModels, startupDiagnostic, StartupModelInitializationError } = require("./server");

test("model initialization preserves the failing model association and original cause", async () => {
  const cause = Object.assign(new Error("E11000 duplicate key mongodb://secret"), {
    code: 11000, collection: "invoices", index: "uniq_invoice", keyPattern: { owner: 1, invoiceNumber: 1 }, keyValue: { owner: "owner-secret", invoiceNumber: "INV-1" },
  });
  await assert.rejects(() => initializeModels([{ modelName: "CreditCustomerInvoice", async init() { throw cause; } }]), error => {
    assert.ok(error instanceof StartupModelInitializationError);
    assert.equal(error.modelName, "CreditCustomerInvoice");
    assert.equal(error.cause, cause);
    return true;
  });
  const diagnostic = startupDiagnostic(new StartupModelInitializationError("CreditCustomerInvoice", cause), "CreditCustomerInvoice");
  assert.equal(diagnostic.model, "CreditCustomerInvoice");
  assert.equal(diagnostic.code, "11000");
  assert.equal(diagnostic.collection, "invoices");
  assert.equal(diagnostic.index, "uniq_invoice");
  assert.equal(diagnostic.keyValue, "<redacted>");
  assert.doesNotMatch(JSON.stringify(diagnostic), /mongodb:\/\/secret|owner-secret/);
});

test("successful model initialization completes all models", async () => {
  let count = 0;
  await initializeModels([{ modelName: "A", async init() { count += 1; } }, { modelName: "B", async init() { count += 1; } }]);
  assert.equal(count, 2);
});
