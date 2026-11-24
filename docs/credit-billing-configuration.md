# Credit customer billing configuration

Credit billing reads immutable customer selling-price and Rate Master snapshots stored with saved shipment bookings. It does not query or recalculate from the current Rate Master.

`Customer.monthlyBillingConfig` remains the existing opaque configuration field. The billing service recognizes these explicit settings:

```json
{
  "billingDateField": "record.date",
  "billableStatusField": "status",
  "billableStatuses": ["Delivered"],
  "gstTreatment": "SNAPSHOT"
}
```

- `billingDateField` is `createdAt` or `record.date`.
- `billableStatusField` is `status` or `bookingStatus`; `billableStatuses` contains exact stored values. No default billable status or billing-date rule is assumed.
- `gstTreatment` is `NOT_APPLICABLE` only when the account's tax treatment has been confirmed; then the stored selling price is used unchanged and tax is zero. `SNAPSHOT` requires the booking-time mode snapshot to contain `taxableAmount`, `gstAmount`, and `invoiceAmount`. This module does not calculate GST.
- Invoice number is supplied by the authenticated operator because SRD V1.0 does not define a numbering format. Invoice date is explicit (or server date if omitted); due date is optional and never inferred.

Only `READY` historical pricing snapshots are eligible. `TEST`, `CONFIGURATION_REQUIRED`, missing currency, missing pricing fields, already-invoiced shipments, and mixed-currency periods block consolidated generation. Invoice totals sum decimal strings exactly without rounding. Generation requires MongoDB transactions and schema unique indexes for owner/customer/period, owner/invoice number, and owner/shipment.

Payment Management records immutable, explicitly dated payment receipts with one or more explicit invoice allocations. Each request requires a caller-provided idempotency key, and payment amount must equal the exact sum of allocations. Payment currency must match every invoice; over-allocation and owner/customer mismatches are rejected. Invoice balances and payment status are updated in the same MongoDB transaction as the payment record, and customer outstanding balance is recomputed from open invoice balances. `outstandingBalanceExact` is the exact Decimal128 source of truth; the legacy numeric `outstandingBalance` field is also synchronized for existing API compatibility.

Payment methods, gateway integration, refund/reversal rules, formal receipt numbering/layout, and unapplied customer credits are not specified. The current flow requires full allocation of each payment and offers printable payment detail, without claiming a jurisdictional receipt format.
