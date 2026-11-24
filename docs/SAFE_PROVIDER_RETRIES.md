# Provider retry policy

Only configured adapters are called; each route checks the adapter capability before invoking this retry helper. The helper performs at most the attempts below, with exponential delay (150 ms base, capped at 1.2 s) and bounded jitter. It retries only HTTP 408, 425, 429, 5xx, known transient network codes, or an explicitly marked retryable error that is not definitive. Other failures are returned immediately. No request or response payloads are logged by the retry helper.

| Operation | Policy | Safety rule |
| --- | --- | --- |
| Partner quote | 2 attempts, 150 ms base, 600 ms cap | Provider quote is read-only; no configured adapter means no call/retry. |
| Booking reconciliation | 3 attempts, 150 ms base, 1.2 s cap | Repeats the lookup with the existing booking idempotency key/reference. Never repeats shipment creation. Existing owner/state/revision conditional writes remain authoritative. |
| Tracking synchronization | 3 attempts, 150 ms base, 1.2 s cap | Provider lookup only; event persistence remains revision-guarded and deduplicated. |
| Pickup synchronization | 3 attempts, 150 ms base, 1.2 s cap | Provider status lookup only; local status/history persistence remains revision-guarded. Pickup creation/cancellation is not retried. |
| NDR provider status lookup | 3 attempts, 150 ms base, 1.2 s cap | Read-only status lookup only. NDR actions are not retried. |
| Other read-only provider operations | 3 attempts, 150 ms base, 1.2 s cap | Explicitly opt into `providerRead`; do not apply to mutations. |

`singleFlight` shares an identical in-flight read within one process. Across application instances, duplicate read calls can still occur; the reads are safe to repeat, and tracking/pickup/booking state writes continue to use database conditional updates. Booking creation, invoice generation, payment allocation, pickup creation, and NDR actions have no automatic retry. Definitive booking rejection remains a definitive failure; timeout or ambiguous booking response remains locked for reconciliation. A provider without the needed adapter/capability is rejected before retry execution.

The single-flight map and retry delays are process-local, not a durable job queue. Background scheduled retries, cross-instance leases, and provider-specific retry-after handling require deployment/operational design and are not implied by this change.
