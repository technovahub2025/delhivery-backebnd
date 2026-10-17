const express = require("express");
const app = express();

app.use("/api/delhivery", require("./route/delhiveryroutes"));

app.use((req, res) => {
  console.log("UNMATCHED REQUEST:", req.method, req.originalUrl);
  res.status(404).json({
    diagnostic: "Route not matched",
    method: req.method,
    path: req.originalUrl
  });
});

app.listen(3001, () => {
  console.log("Diagnostic server listening on port 3001");
});
