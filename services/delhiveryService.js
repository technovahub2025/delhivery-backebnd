const axios = require("axios");

function getDelhiveryConfig() {
  const baseURL = process.env.DELHIVERY_BASE_URL?.trim().replace(/\/+$/, "");
  const apiToken = process.env.DELHIVERY_API_TOKEN?.trim();

  if (!baseURL || !apiToken) {
    const error = new Error(
      "Delhivery is not configured. Set DELHIVERY_BASE_URL and DELHIVERY_API_TOKEN."
    );
    error.code = "DELHIVERY_CONFIGURATION_ERROR";
    error.status = 500;
    throw error;
  }

  return { baseURL, apiToken };
}

const delhiveryApi = axios.create({
  timeout: 30000,
  headers: {
    Accept: "application/json",
  },
});

// Resolve credentials for every request so they are applied consistently and
// are never included in a response sent to the frontend.
delhiveryApi.interceptors.request.use((config) => {
  const { baseURL, apiToken } = getDelhiveryConfig();

  config.baseURL = baseURL;
  config.headers.Authorization = `Token ${apiToken}`;

  console.info("Delhivery request authentication:", {
    method: config.method?.toUpperCase(),
    path: config.url,
    baseUrl: baseURL,
    tokenConfigured: true,
    tokenLength: apiToken.length,
  });

  return config;
});

module.exports = delhiveryApi;
