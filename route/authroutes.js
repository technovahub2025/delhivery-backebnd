const express = require("express");
const router = express.Router();
const { createAuthRateLimit } = require("../utils/httpSecurity");

const {
  register,
  login,
} = require("../controller/authcontroller");

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.post("/register", createAuthRateLimit(), register);
router.post("/login", createAuthRateLimit(), login);

module.exports = router;
