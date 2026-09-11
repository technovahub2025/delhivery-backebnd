const axios = require("axios");



exports.checkPincodeServiceability = async (req, res) => {
  try {
    const { pincode } = req.query;

    // Validate pincode
    if (!pincode) {
      return res.status(400).json({
        success: false,
        message: "Pincode is required",
      });
    }

    if (!/^\d{6}$/.test(pincode)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 6-digit pincode",
      });
    }

    // Delhivery API URL
    const url =
      "https://staging-express.delhivery.com/c/api/pin-codes/json/";

    const response = await axios.get(url, {
      params: {
        filter_codes: pincode,
      },

      headers: {
        Authorization: `Token ${process.env.DELHIVERY_API_TOKEN}`,
        Accept: "application/json",
      },
    });

    const data = response.data;

    // Check if API returned data
    const deliveryCodes =
      data?.delivery_codes || data?.delivery_codes?.length
        ? data.delivery_codes
        : [];

    // No serviceability
    if (!deliveryCodes || deliveryCodes.length === 0) {
      return res.status(200).json({
        success: true,
        pincode,
        serviceable: false,
        status: "NSZ",
        message: "This pincode is not serviceable",
        data: [],
      });
    }

    // Get first result
    const result = deliveryCodes[0];

    // Delhivery API generally returns postal_code details
    const postalCode = result?.postal_code;

    // Check Embargo
    const isEmbargo =
      postalCode?.remark &&
      postalCode.remark.toLowerCase() === "embargo";

    return res.status(200).json({
      success: true,
      pincode,
      serviceable: !isEmbargo,
      status: isEmbargo ? "TEMPORARILY_NSZ" : "SERVICEABLE",
      remark: postalCode?.remark || "",
      message: isEmbargo
        ? "Pincode is temporarily not serviceable due to embargo"
        : "Pincode is serviceable",
      data: result,
    });
  } catch (error) {
    console.error(
      "Delhivery Pincode Error:",
      error.response?.data || error.message
    );

    return res.status(error.response?.status || 500).json({
      success: false,
      message: "Failed to check pincode serviceability",
      error: error.response?.data || error.message,
    });
  }
};


// ==========================================
// HEAVY PRODUCT PINCODE SERVICEABILITY
// ==========================================

exports.checkHeavyPincodeServiceability = async (req, res) => {
  try {
    const { pincode } = req.query;

    // Validate pincode
    if (!pincode) {
      return res.status(400).json({
        success: false,
        message: "Pincode is required",
      });
    }

    if (!/^\d{6}$/.test(pincode)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 6-digit pincode",
      });
    }

    const url =
      "https://staging-express.delhivery.com/api/dc/fetch/serviceability/pincode";

    const response = await axios.get(url, {
      params: {
        product_type: "Heavy",
        pincode: pincode,
      },

      headers: {
        Authorization: `Token ${process.env.DELHIVERY_API_TOKEN}`,
        Accept: "application/json",
      },
    });

    const data = response.data;

    // Check NSZ response
    const isNSZ =
      JSON.stringify(data).toUpperCase().includes("NSZ");

    return res.status(200).json({
      success: true,
      pincode,
      productType: "Heavy",
      serviceable: !isNSZ,
      status: isNSZ ? "NSZ" : "SERVICEABLE",
      message: isNSZ
        ? "Heavy shipment is not serviceable for this pincode"
        : "Heavy shipment is serviceable for this pincode",
      data: data,
    });
  } catch (error) {
    console.error(
      "Delhivery Heavy Pincode Error:",
      error.response?.data || error.message
    );

    return res.status(error.response?.status || 500).json({
      success: false,
      message: "Failed to check heavy pincode serviceability",
      error: error.response?.data || error.message,
    });
  }
};