const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");

const dotenvResult = dotenv.config({ quiet: true });
if (dotenvResult.error) {
  console.error("Unable to load .env configuration:", dotenvResult.error.message);
}

const app = express();

// CORS
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(express.json());

// Routes
const authRoutes = require("./route/authroutes");
app.use("/api/auth", authRoutes);

const delhiveryRoutes = require("./route/delhiveryroutes");
app.use("/api/delhivery", delhiveryRoutes);

// MongoDB Connection
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB Connected");
  })
  .catch((error) => {
    console.log("MongoDB Connection Error:", error);
  });

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.info("Delhivery configuration loaded:", {
    baseUrl: process.env.DELHIVERY_BASE_URL || "not configured",
    tokenConfigured: Boolean(process.env.DELHIVERY_API_TOKEN?.trim()),
    tokenLength: process.env.DELHIVERY_API_TOKEN?.trim().length || 0,
  });
});
