function handleError(res, error) {
  const upstreamStatus = error.response?.status || error.status || 500;
  const upstreamData = error.response?.data;
  const upstreamMessage =
    (typeof upstreamData === "string" && upstreamData) ||
    upstreamData?.detail ||
    upstreamData?.message ||
    upstreamData?.error ||
    error.message ||
    "Unknown Delhivery API error";

  console.error("Delhivery API request failed:", {
    status: upstreamStatus,
    message: upstreamMessage,
  });

  return res.status(upstreamStatus).json({
    success: false,
    message: "Delhivery API request failed",
    statusCode: upstreamStatus,
    error: upstreamMessage,
  });
}
module.exports = handleError;
