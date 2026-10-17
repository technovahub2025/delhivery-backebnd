require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const PickupRequest = require("./model/pickupRequest");
const marker = "LOCAL-PERSISTENCE-TEST-" + require("crypto").randomUUID();

(async () => {
  let testId;
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const record = await PickupRequest.create({
      owner: marker,
      carrierRequestId: marker,
      pickupDate: "2099-01-01",
      pickupTime: "10:00:00",
      warehouse: marker,
      packageCount: 1,
      status: "TEST ONLY",
      request: { testOnly: true },
      carrierResponse: { testOnly: true }
    });

    testId = record._id;
    const found = await PickupRequest.findById(testId).lean();

    console.log("Save successful:", Boolean(found));
    console.log("Test record ID:", String(testId));
  } catch (error) {
    console.error("Persistence test failed:", error.message);
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState === 1) {
      if (testId) {
        const result = await PickupRequest.deleteOne({
          _id: testId,
          "request.testOnly": true,
          "carrierResponse.testOnly": true
        });
        console.log("Temporary test record removed:", result.deletedCount === 1);
      }
      await mongoose.disconnect();
    }
  }
})();
