# Local mock courier booking tests

The `MOCK_LOCAL` adapter exercises the quote and booking flow without contacting a carrier. By default it returns a synthetic quote and saves the shipment as `BOOKED_AWB_PENDING`. The optional sample AWB flow below produces an explicitly marked test identifier.

## Required runtime gates

The adapter is available only when all of these are true:

- The process runs in development or test, or uses explicit hosted `APP_DEPLOYMENT_MODE=uat`.
- `MOCK_COURIER_ADAPTER_ENABLED=true` exactly.
- The active, connected Mongoose database name is exactly `courier_testing`.

The booking registry exposes `MOCK_LOCAL` only when these guards pass. Carrier reads use separate capabilities. Use **Compare sample couriers** in the draft screen to explicitly request local sample estimates.

Standard Delhivery PIN serviceability uses the configured carrier URL and credentials independently of mock booking unless the PIN capability is explicitly disabled. To exercise fixture serviceability, call `GET /api/delhivery/pincode?pincode=110001&source=sample` with an authenticated isolated mock session. The serviceability screens label the result source and show carrier failures so the operator can retry.

## Enable and disable

For a local backend process, set the required environment values before starting the backend:

```dotenv
NODE_ENV=development
MOCK_COURIER_ADAPTER_ENABLED=true
MONGO_URI=<your connection URI whose database name is courier_testing>
DELHIVERY_SHIPMENT_BOOKING_ENABLED=false
```

Optional demo settings for the same isolated process:

```dotenv
MOCK_COURIER_SAMPLE_AWB_ENABLED=true
MOCK_COURIER_SAMPLE_PINCODES=110001,400001
MOCK_COURIER_SURFACE_SAMPLE=65
MOCK_COURIER_EXPRESS_SAMPLE=95
DEMO_WALK_IN_PAYMENT_METHODS=CASH,UPI
```

The sample AWB option also enables the owned sample label and a local pickup-pending scan. The label screen prints a sample watermark. The demo receipt records the booking-time amount in MongoDB and does not initiate a payment. Prefix sample rate-card names with SAMPLE or DEMO to keep them separate from live bookings and ordinary credit invoices. Live quote failures stay visible on the live comparison. Operators can request sample estimates separately.

For a demo browser session, configure the frontend's `VITE_API_BASE_URL` to the isolated backend's `/api` base URL. Use an isolated account with a sample warehouse and rate card. The backend's demo gates use the actual connected database name.

Restart the backend after changing its environment. Verify that the application is connected to `courier_testing` before requesting quotes. The adapter does not require or read Delhivery credentials and its quote or booking methods contain no network client.

Disable it by unsetting `MOCK_COURIER_ADAPTER_ENABLED` or setting it to `false`, then restart the backend. Do not enable the Delhivery adapter as a substitute for the mock.

Quote and booking requests update the selected draft through the normal owner-scoped flow. Use a separate disposable test draft; do not book an existing sample draft that must remain unchanged. The resulting saved AppShipment has `state: saved`, `bookingStatus: BOOKED_AWB_PENDING`, an empty waybill, and a `MOCK_LOCAL` marker. This lets the owner-scoped dashboard count it without representing that a carrier booking or AWB exists.
