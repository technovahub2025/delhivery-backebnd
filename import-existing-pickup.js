require("dotenv").config();
const mongoose = require("mongoose");
const PickupRequest = require("./model/pickupRequest");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const carrierRequestId = "329277741";
  const owner = "6ac63bcbe1cd26f844174e3c";

  // Never create a duplicate carrier request record.
  const existing = await PickupRequest.findOne({ carrierRequestId });

  if (existing) {
    console.log("Already exists in MongoDB:", {
      id: existing.carrierRequestId,
      owner: existing.owner,
      status: existing.status
    });
    return;
  }

  const record = await PickupRequest.create({
    owner,
    carrierRequestId,
    pickupDate: "2026-10-17",
    pickupTime: "14:00–18:00",
    warehouse: "Demo Warehouse",
    packageCount: 1,
    status: "Dispatched",
    request: {
      source: "manual-reconciliation",
      note: "Existing Delhivery pickup; no new pickup was created."
    },
    carrierResponse: {
      pickup_request_id: carrierRequestId,
      status: "Dispatched",
      source: "verified-in-original-Delhivery-dashboard"
    }
  });

  console.log("Existing pickup imported successfully:", {
    id: record.carrierRequestId,
    owner: record.owner,
    status: record.status
  });
}

main()
  .catch(error => {
    console.error("Import failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
