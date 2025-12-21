const express = require("express");
const scrape = require("./working");
const app = express();

app.use(express.json());

app.post("/scrape", async (req, res) => {
  try {
    const { url } = req.body;
    
    // Validate URL exists
    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }
    
    // Call scraper with just the URL
    const result = await scrape({ url });
    res.json(result);
    
  } catch (err) {
    console.error("Scraping error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Puppeteer service running on port ${PORT}`);
});
