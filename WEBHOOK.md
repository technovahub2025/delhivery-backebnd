# Delhivery webhook

Endpoint: `POST /api/delhivery/webhook`

Send `Content-Type: application/json` and a non-empty JSON object.
The controller saves the complete body under `payload` in the MongoDB
`delhiverywebhooks` collection, with `createdAt` and `updatedAt` timestamps.
It returns HTTP 200 only after the save succeeds, HTTP 400 for an empty or
invalid body shape, and HTTP 500 if saving fails.

Example response:

```json
{
  "success": true,
  "message": "Webhook received successfully"
}
```

The endpoint stores events only; it does not update shipment records or
deduplicate repeated deliveries. No sender verification is configured.
Field mapping and sender verification require your actual Delhivery webhook
payload and account configuration.
