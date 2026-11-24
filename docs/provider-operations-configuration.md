# Provider operations configuration

## Status mappings

Status labels are preserved as received. `COURIER_STATUS_MAPPINGS_JSON` may configure exact provider labels to application states. The backend validates the JSON at startup and normalizes label keys for case and whitespace matching. Unsupported values fail configuration validation. Unknown labels return no mapping and are not treated as terminal states.

Supported mapping domains and application values:

- `shipment`: `IN_TRANSIT`, `DELIVERED`, `FAILED`, `EXCEPTION`
- `pickup`: `SCHEDULED`, `COMPLETED`, `CANCELLED`, `FAILED`
- `rtoTrigger`: `RTO_TRIGGER`
- `rto`: `ACTIVE`, `COMPLETED`, `UNRESOLVED`

Configuration shape (replace placeholders only with values confirmed by the provider; this is not a carrier mapping):

```json
{
  "<PROVIDER_CODE>": {
    "shipment": { "<EXACT_PROVIDER_LABEL>": "IN_TRANSIT" },
    "pickup": { "<EXACT_PROVIDER_LABEL>": "SCHEDULED" },
    "rtoTrigger": { "<EXACT_RTO_TRIGGER_LABEL>": "RTO_TRIGGER" },
    "rto": { "<EXACT_RTO_PROGRESS_LABEL>": "ACTIVE" }
  }
}
```

The RTO trigger map explicitly identifies which provider events create RTO records. The `rto` map independently identifies lifecycle state. Unmapped progress becomes `UNRESOLVED`; it never marks a record completed.

No Delhivery labels are supplied in this repository because provider mapping documentation has not been confirmed. Until mappings are configured, shipment-status and RTO lifecycle dashboard metrics report unavailable where source data cannot be classified.

## Webhooks

The receiver supports the documented default Scan Push payload and a client-configured Authorization header. Deployment setup and the remaining account-specific verification are described in [WEBHOOK.md](../WEBHOOK.md).

## Pickup status synchronization

Carrier pickup synchronization is adapter-driven. An adapter must provide `syncPickup`, and its raw status must have a confirmed `pickup` mapping before the request record is changed. No Delhivery pickup status endpoint or status labels are assumed here.
