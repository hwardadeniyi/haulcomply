const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send(`
    <h1>HaulComply</h1>
    <p>DOT Compliance Software for Dump Truck Fleets</p>
  `);
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("Web server running on port " + port);
});
