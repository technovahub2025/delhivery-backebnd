# Delhivery Scan Push

The receiver is `POST /api/delhivery/webhook`. It accepts Delhivery's documented default shipment scan payload. It matches the AWB, provider, and order reference when present against saved shipments. Ambiguous or unknown matches never update a shipment. Accepted events update the tracking timeline and are archived with a unique replay key.

To activate on an approved environment, configure Delhivery to send the agreed Authorization header over HTTPS. Store that exact header value as `DELHIVERY_WEBHOOK_AUTHORIZATION` in server-side secret storage. Use a dedicated high-entropy value. The receiver requires at least 32 characters. Set `DELHIVERY_TRACKING_UTC_OFFSET` to the account's confirmed offset for timestamps without one. Timestamps with an explicit offset use that offset. The receiver remains unavailable until `DELHIVERY_TRACKING_WEBHOOK_ENABLED=true` and sender authentication is configured. Mock mode also disables the receiver.

The header is client-configured under the public Scan Push contract. If the account uses a different payload or a signed scheme, obtain its exact sample and verification contract before activation. Confirm the unique archive index and test delivery and replay using isolated staging fixtures. The application has no production-verified account push.

The Webhook Events screen reads `GET /api/delhivery/webhook/events` using the signed-in user's session. The endpoint lists owner-scoped archived Delhivery scans, supports exact AWB filtering and pagination, and returns event summaries. It does not send raw callback payloads to the browser. Existing archives remain readable when inbound Scan Push is disabled.

[Delhivery Scan Push reference](https://delhivery-express-api-doc.readme.io/reference/tracking-via-push-api-webhook-1)
