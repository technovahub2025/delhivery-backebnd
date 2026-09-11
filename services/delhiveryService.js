const axios = require("axios");

const delhiveryApi = axios.create({
  baseURL: process.env.DELHIVERY_BASE_URL,
  timeout: 30000,
  headers: {
    Authorization: `Token ${process.env.DELHIVERY_API_TOKEN}`,
    Accept: "application/json",
  },
});

module.exports = delhiveryApi;
