function readDelhiveryConfiguration(environment = process.env) {
  const baseURL = environment.DELHIVERY_BASE_URL?.trim().replace(/\/+$/, "");
  const apiToken = environment.DELHIVERY_API_TOKEN?.trim();
  let url;
  try { url = new URL(baseURL); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !apiToken) return null;
  return { baseURL, apiToken };
}

module.exports = { readDelhiveryConfiguration };
