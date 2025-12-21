const express = require("express");
const scrape = require("./working");

const app = express();
app.use(express.json());

app.post("/scrape", async (req, res) => {
  try {
    const { url, longDesc } = req.body;
    const result = await scrape({ url, longDesc });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.send("OK"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Puppeteer service running");
});
