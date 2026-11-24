const User = require("../model/model");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { readActivePolicy } = require("../utils/rbacAuthorization");

// REGISTER API
exports.register = async (req, res) => {
  try {
    if (process.env.AUTH_REGISTRATION_ENABLED !== "true" &&
        (process.env.NODE_ENV === "production" || process.env.AUTH_REGISTRATION_ENABLED !== undefined)) {
      return res.status(403).json({ success: false, message: "Registration is disabled. Contact your administrator." });
    }
    const { name, email: rawEmail, password } = req.body || {};
    const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";

    // Validation
    if (typeof name !== "string" || !name.trim() || !/^[^\s@]+@[^\s@]+$/.test(email) ||
        email.length > 254 || typeof password !== "string" || password.length < 6 || Buffer.byteLength(password) > 72) {
      return res.status(400).json({
        success: false,
        message: "Provide a name, valid email, and a password of at least 6 characters and at most 72 bytes.",
      });
    }

    // Check existing user
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "User already exists",
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = await User.create({
      name: name.trim(),
      email,
      password: hashedPassword,
    });

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: null,
        permissions: [],
      },
    });
  } catch (error) {
    if (error?.code === 11000) return res.status(400).json({ success: false, message: "User already exists" });
    res.status(500).json({
      success: false,
      message: "Registration could not be completed.",
    });
  }
};


// LOGIN API
exports.login = async (req, res) => {
  try {
    const { email: rawEmail, password } = req.body || {};
    const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";

    // Validation
    if (!email || email.length > 254 || typeof password !== "string" || !password || Buffer.byteLength(password) > 1024) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }
    if (!process.env.JWT_SECRET) return res.status(503).json({ success: false, message: "Authentication is not configured." });

    // Find user
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    if (user.active === false) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Generate JWT Token
    const token = jwt.sign(
      {
        id: user._id,
        email: user.email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    let authorization = { status: "pending", role: null, permissions: [] };
    try {
      const policy = await readActivePolicy();
      const roleKey = typeof user.roleKey === "string" ? user.roleKey : "";
      if (policy.status === "active" && policy.roles[roleKey] && user.active !== false) {
        authorization = { status: "active", role: roleKey, permissions: policy.roles[roleKey] };
      } else if (policy.status === "invalid") {
        authorization = { status: "invalid", role: null, permissions: [] };
      }
    } catch {
      // Preserve login/token compatibility while authorization remains fail-closed on APIs.
    }

    res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: authorization.role,
        permissions: authorization.permissions,
        authorizationStatus: authorization.status,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Login could not be completed.",
    });
  }
};
