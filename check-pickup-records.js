require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const PickupRequest = require("./model/pickupRequest");

async function main() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Database:", mongoose.connection.name);

    const count = await PickupRequest.countDocuments();
    console.log("Total pickup records:", count);

    const records = await PickupRequest.find({})
      .select("carrierRequestId pickupDate pickupTime warehouse packageCount status createdAt")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    console.log("Recent pickup records:");
    console.log(JSON.stringify(records, null, 2));
  } catch (error) {
    console.error("Database check failed:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main();
