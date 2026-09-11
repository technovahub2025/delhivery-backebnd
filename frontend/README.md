# Frontend Axios integration

Copy `api.mjs` to your frontend's `src/services/` folder and install Axios
there with `npm install axios`. Import it using:

```js
import { api } from "./services/api.mjs";
```

The default backend is `http://localhost:3000/api`. Run the frontend on a
different port. For another backend URL, create one shared instance with
`createApi({ baseURL: "https://your-backend.example/api" })`.

## Wire existing form submit handlers

Use form state, rather than hardcoded sample values:

```js
const { user, token } = await api.login({ email, password });
const registration = await api.register({ name, email, password });
const result = await api.checkPincode(pincode);
const tracking = await api.trackShipment({ waybill });
const shipment = await api.createShipment(shipmentBody);
```

Login configures the JWT in memory for subsequent calls. On logout, call
`api.logout()` and clear your frontend's user state. A page reload clears
the in-memory token. The current backend does not enforce JWT authorization.

For each screen, replace its mock-data import and simulated timers with the
corresponding API method. Initialize results to `null` or an empty array,
show a loading state during the request, catch errors, and clear stale results
on failure. Only show success or navigate after the awaited request succeeds.
Never fall back to dummy data or automatically retry shipment creation,
waybill generation, or other mutations.

Most Delhivery methods return `{ success, data }`; login returns
`{ success, token, user }`. Pincode also has a top-level `serviceable` value.
Keep provider-specific checks when interpreting `data`: failure formats may
vary. Labels and documents return JSON, not a downloadable file blob.

The API module covers the 17 browser-facing backend routes. `/webhook` is a
callback receiver for Delhivery and should not be called to populate a screen.
There are currently no read endpoints for shipment lists, dashboard metrics,
warehouse lists, pickup lists, or webhook history. Show an unavailable state
for those views until read endpoints exist; do not invent data or routes.

The frontend screen source is not present in this workspace. This module is
ready to import, but existing screens have not been modified or connected.
