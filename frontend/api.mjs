import axios from "axios";

// Change baseURL when the backend is hosted elsewhere.
// Only the application's login JWT belongs here, never the Delhivery API token.
export function createApi({ baseURL = "http://localhost:3000/api", adapter } = {}) {
  const client = axios.create({
    baseURL,
    timeout: 30000,
    headers: { Accept: "application/json" },
    ...(adapter ? { adapter } : {}),
  });

  function setAuthToken(token) {
    if (token) {
      client.defaults.headers.common.Authorization = `Bearer ${token}`;
    } else {
      delete client.defaults.headers.common.Authorization;
    }
  }

  async function request(config) {
    let response;
    try {
      response = await client.request(config);
    } catch (error) {
      if (axios.isCancel(error)) throw error;
      const message = error.response?.data?.message;
      const failure = new Error(
        typeof message === "string"
          ? message
          : error.response
            ? `Request failed (${error.response.status})`
            : error.code === "ECONNABORTED"
              ? "The request timed out. Check its status before submitting again."
              : "Cannot reach the backend. Check the server URL and connection.",
        { cause: error }
      );
      failure.status = error.response?.status;
      failure.details = error.response?.data;
      throw failure;
    }

    const result = response.data;
    // The backend may wrap a provider failure inside a successful HTTP response.
    if (result?.success === false || result?.data?.success === false) {
      const message = result?.data?.success === false
        ? result.data.message
        : result.message;
      const failure = new Error(
        typeof message === "string" ? message : "The API could not complete the request"
      );
      failure.status = response.status;
      failure.details = result;
      throw failure;
    }

    // Preserve the backend envelope: auth has token/user; Delhivery has data.
    return result;
  }

  const get = (url, params, signal) => request({ method: "GET", url, params, signal });
  const post = (url, data) => request({ method: "POST", url, data });

  return {
    setAuthToken,
    logout: () => setAuthToken(null),

    register: ({ name, email, password }) =>
      post("/auth/register", { name, email, password }),

    async login({ email, password }) {
      const result = await post("/auth/login", { email, password });
      setAuthToken(result.token);
      return result;
    },

    checkPincode: (pincode, signal) =>
      get("/delhivery/pincode", { pincode }, signal),

    checkHeavyPincode: (pincode, signal) =>
      get("/delhivery/pincode/heavy", { pincode }, signal),

    getExpectedTat: ({ origin_pin, destination_pin, mot = "S" }, signal) =>
      get("/delhivery/expected-tat", { origin_pin, destination_pin, mot }, signal),

    // Explicit user action only: this GET allocates waybills.
    fetchWaybill: (count = 1) => get("/delhivery/waybills", { count }),

    createShipment: (body) => post("/delhivery/shipments", body),
    updateShipment: (body) => post("/delhivery/shipments/update", body),
    cancelShipment: (waybill) => post("/delhivery/shipments/cancel", { waybill }),
    updateEwaybill: (body) => post("/delhivery/shipments/ewaybill", body),

    trackShipment: ({ waybill, ref_ids }, signal) =>
      get("/delhivery/shipments/track", { waybill, ref_ids }, signal),

    calculateShippingCost: ({ md, ss, d_pin, o_pin, cgm, pt }, signal) =>
      get("/delhivery/shipping-cost", { md, ss, d_pin, o_pin, cgm, pt }, signal),

    generateShippingLabel: (waybill, pdf = true, signal) =>
      get("/delhivery/shipping-label", { waybill, pdf }, signal),

    createPickupRequest: (body) => post("/delhivery/pickups", body),
    createWarehouse: (body) => post("/delhivery/warehouses", body),
    updateWarehouse: (body) => post("/delhivery/warehouses/update", body),
    downloadDocument: (waybill, signal, docType = "EPOD") =>
      get("/delhivery/documents", { waybill, doc_type: docType }, signal),
  };
}

export const api = createApi();
