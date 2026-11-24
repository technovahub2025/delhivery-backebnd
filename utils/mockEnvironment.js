const ALLOWED_TEST_ENVIRONMENTS = new Set(["development", "test"]);
function isMockCourierAdapterEnabled({ nodeEnv, deploymentMode, enabled, databaseName } = {}) {
  return deploymentMode !== "production" &&
    (deploymentMode === "uat" || ALLOWED_TEST_ENVIRONMENTS.has(String(nodeEnv || "").trim().toLowerCase())) &&
    enabled === "true" && databaseName === "courier_testing";
}
module.exports = { isMockCourierAdapterEnabled };
