const axios = require("axios");
const mongoose = require("mongoose");
const DelhiveryIntegrationEvent = require("../model/delhiveryIntegrationEvent");
const { createIntegrationLogger } = require("../utils/delhiveryIntegrationLogging");
const { readDelhiveryConfiguration } = require("../utils/delhiveryConfiguration");
const startedAt = Symbol("delhiveryRequestStartedAt");
const recordAttempt = createIntegrationLogger({
  Event: DelhiveryIntegrationEvent,
  databaseReady: () => mongoose.connection.readyState === 1,
});

function getDelhiveryConfig() {
  const config = readDelhiveryConfiguration();
  if (!config) {
    const error = new Error(
      "Delhivery is not configured. Set DELHIVERY_BASE_URL and DELHIVERY_API_TOKEN."
    );
    error.code = "DELHIVERY_CONFIGURATION_ERROR";
    error.status = 500;
    throw error;
  }

  return config;
}

const delhiveryApi = axios.create({
  timeout: 30000,
  maxRedirects: 0,
  allowAbsoluteUrls: false,
  headers: {
    Accept: "application/json",
  },
});

// Resolve credentials for every request so they are applied consistently and
// are never included in a response sent to the frontend.
delhiveryApi.interceptors.request.use((config) => {
  const { baseURL, apiToken } = getDelhiveryConfig();

  config[startedAt] = Date.now();
  config.baseURL = baseURL;
  config.headers.Authorization = `Token ${apiToken}`;

  return config;
});

function logAttempt(config, status, failed) {
  if (Number.isFinite(config?.[startedAt])) recordAttempt(config, config[startedAt], status, failed);
}

delhiveryApi.interceptors.response.use(response => {
  logAttempt(response.config, response.status, false);
  return response;
}, error => {
  logAttempt(error.config, error.response?.status, true);
  return Promise.reject(error);
});

module.exports = delhiveryApi;
