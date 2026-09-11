function handleError(res, error) {
  console.error(
    error.response?.data || error.message
  );

  return res.status(error.response?.status || 500).json({
    success: false,
    message: "Delhivery API request failed",
    error: error.response?.data || error.message,
  });
}
module.exports = handleError;
