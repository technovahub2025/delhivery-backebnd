# Delhivery feature gates

In production, capabilities default on when the validated HTTPS service URL and token are configured. Set an individual capability to `false` as a safety override when it must remain disabled. UAT/test environments remain explicit opt-in and preserve mock-mode mutation protections. Pickup status remains opt-in because no verified provider status contract is implemented. The legacy `COURIER_DELHIVERY_ADAPTER_ENABLED` variable does not control these operations.

| Feature | Environment variable | Route/adapter operation |
| --- | --- | --- |
| Pincode serviceability | `DELHIVERY_PINCODE_SERVICEABILITY_ENABLED` | `GET /api/delhivery/pincode` |
| Heavy pincode serviceability | `DELHIVERY_HEAVY_PINCODE_SERVICEABILITY_ENABLED` | `GET /api/delhivery/pincode/heavy` |
| Shipping cost enquiry | `DELHIVERY_SHIPPING_COST_ENABLED` | `GET /api/delhivery/shipping-cost`; Delhivery quote adapter |
| Expected TAT | `DELHIVERY_EXPECTED_TAT_ENABLED` | `GET /api/delhivery/expected-tat` |
| Waybill allocation | `DELHIVERY_WAYBILL_ALLOCATION_ENABLED` | `POST /api/delhivery/waybills`; GET/HEAD do not allocate |
| Warehouse creation | `DELHIVERY_WAREHOUSE_CREATE_ENABLED` | `POST /api/delhivery/warehouses` |
| Warehouse update | `DELHIVERY_WAREHOUSE_UPDATE_ENABLED` | `POST /api/delhivery/warehouses/update` |
| Shipment booking | `DELHIVERY_SHIPMENT_BOOKING_ENABLED` | Legacy `POST /api/delhivery/shipments`; Delhivery adapter `book()`; direct-booking readiness API |
| Shipment update | `DELHIVERY_SHIPMENT_UPDATE_ENABLED` | `POST /api/delhivery/shipments/update`; adapter `updateShipment()` |
| Shipment cancellation | `DELHIVERY_SHIPMENT_CANCELLATION_ENABLED` | `POST /api/delhivery/shipments/cancel`; adapter `cancelShipment()` |
| E-waybill | `DELHIVERY_EWAYBILL_ENABLED` | `POST /api/delhivery/shipments/ewaybill`; adapter `updateEwaybill()` |
| Pickup creation | `DELHIVERY_PICKUP_CREATION_ENABLED` | `POST /api/delhivery/pickups`; adapter `createPickup()` |
| Pickup status | `DELHIVERY_PICKUP_STATUS_ENABLED` | Pickup sync route is gated; no provider sync method is implemented pending a verified API contract |
| Tracking | `DELHIVERY_TRACKING_ENABLED` | Tracking sync and read-only AWB recovery for draft bookings |
| Scheduled tracking | `DELHIVERY_TRACKING_POLL_ENABLED` | Requires Tracking and a real tracking adapter. `DELHIVERY_TRACKING_POLL_MINUTES` defaults to 60 with a supported range of 15–1440. Claims up to 25 eligible recently active real shipments per pass, including while mock booking is on. |
| Label retrieval | `DELHIVERY_LABELS_ENABLED` | `GET /api/delhivery/shipping-label` |
| Document retrieval | `DELHIVERY_DOCUMENTS_ENABLED` | `GET /api/delhivery/documents` |
| Reverse order creation | `DELHIVERY_REVERSE_ORDERS_ENABLED` | `POST /api/delhivery/reverse-orders` |
| NDR actions | `DELHIVERY_NDR_OPERATIONS_ENABLED` | NDR action submission only |
| NDR status | `DELHIVERY_NDR_STATUS_ENABLED` | Owner-scoped upload status lookup |
| Scan Push | `DELHIVERY_TRACKING_WEBHOOK_ENABLED` | Inbound tracking callback, also requires configured sender authentication |

With `MOCK_COURIER_ADAPTER_ENABLED=true`, the booking registry exposes only `MOCK_LOCAL` when connected to `courier_testing` in development, test, or explicit hosted UAT. Invalid mock prerequisites expose no booking adapter. Each carrier read uses its own capability. `DELHIVERY_READS_IN_MOCK_MODE_ENABLED` is no longer required. The standard PIN tools call the live endpoint with configured credentials unless explicitly disabled. In UAT/test, the corresponding capability must be explicitly enabled; in production it defaults on when provider configuration is valid. Sample comparisons and sample PIN lookups require an explicit `source=sample` request and isolated mock mode. A live estimate in UAT remains estimate-only.

Hosted UAT blocks outbound carrier mutations even if their operation flags are set. Scan Push is a separately authenticated inbound operation and can be enabled for hosted UAT using the UAT callback and its dedicated authorization. Live booking also requires pincode serviceability verification. A Delhivery draft quote without a provider expiry must pass a fresh rate check before submission.

Tracking synchronization is scoped to the owned saved shipment and uses only its recorded provider. Real Delhivery shipments require a numeric carrier AWB. Set `DELHIVERY_TRACKING_UTC_OFFSET` to the provider-confirmed offset if the carrier account sends timestamps without a zone. Offset-bearing timestamps always retain their own offset. A valid empty carrier reply leaves the stored timeline unchanged.

The provider credential and base URL remain backend-only. No credential is required in frontend configuration. Configure feature gates only through the deployment's approved secret/configuration management after client authorization; this document does not enable any feature.

## Provider contract gap

The current code and supplied integration details do not establish a Delhivery pickup-status lookup endpoint, identifier, response schema, or status mapping. The pickup sync action therefore remains unavailable even if the status feature is enabled. Scan Push setup is documented in [WEBHOOK.md](../WEBHOOK.md).
