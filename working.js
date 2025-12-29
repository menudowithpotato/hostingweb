const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

let browser;
let pagePool = [];
const MAX_POOL_SIZE = 3;

/* =========================
   BROWSER SINGLETON WITH PAGE POOL
========================= */
async function getBrowser() {
  if (browser) return browser;

  browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process"
    ]
  });

  return browser;
}

async function getPageFromPool() {
  if (pagePool.length > 0) {
    return pagePool.pop();
  }
  const browser = await getBrowser();
  const page = await browser.newPage();
  await setupPage(page);
  return page;
}

async function returnPageToPool(page) {
  if (pagePool.length < MAX_POOL_SIZE) {
    try {
      await page.goto('about:blank');
      pagePool.push(page);
    } catch {
      try { await page.close(); } catch {}
    }
  } else {
    try { await page.close(); } catch {}
  }
}

async function closeBrowser() {
  pagePool.forEach(page => {
    try { page.close(); } catch {}
  });
  pagePool = [];
  
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

process.on("SIGTERM", closeBrowser);
process.on("SIGINT", closeBrowser);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* =========================
   CAPTCHA / BLOCK DETECTION
========================= */
async function detectBlocks(page) {
  try {
    const blockInfo = await page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      const title = document.title.toLowerCase();
      
      return {
        isCaptcha: bodyText.includes("enter the characters") || 
                   title.includes("captcha") ||
                   bodyText.includes("type the characters"),
        isCloudflare: bodyText.includes("checking your browser") ||
                      bodyText.includes("cloudflare") ||
                      title.includes("just a moment"),
        isBlocked: bodyText.includes("sorry, we just need to make sure") ||
                   bodyText.includes("robot") ||
                   bodyText.includes("automated access"),
        hasContent: !!document.querySelector("#productTitle")
      };
    });

    if (blockInfo.isCaptcha) {
      throw new Error("❌ Amazon CAPTCHA detected - request blocked");
    }
    
    if (blockInfo.isCloudflare) {
      throw new Error("❌ Cloudflare challenge detected - waiting for bypass");
    }
    
    if (blockInfo.isBlocked && !blockInfo.hasContent) {
      throw new Error("❌ Amazon bot detection triggered - IP flagged");
    }

    return blockInfo.hasContent;
  } catch (err) {
    if (err.message.includes("CAPTCHA") || err.message.includes("Cloudflare") || err.message.includes("blocked")) {
      throw err;
    }
    return false;
  }
}

/* =========================
   OPTIMIZED REQUEST INTERCEPTION
========================= */
async function setupRequestInterception(page) {
  const blockedResources = new Set(['image', 'stylesheet', 'font', 'media', 'texttrack', 'object', 'beacon', 'csp_report', 'imageset']);
  
  try {
    await page.setRequestInterception(true);
    
    page.on('request', req => {
      if (blockedResources.has(req.resourceType())) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });
  } catch {}
}

/* =========================
   PAGE SETUP
========================= */
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/118.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function setupPage(page) {
  await page.setUserAgent(getRandomUserAgent());
  await page.setDefaultNavigationTimeout(30000);
  await page.setDefaultTimeout(30000);
  await setupRequestInterception(page);
  
  // Optimize page performance
  await page.setViewport({ width: 1920, height: 1080 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
}

function extractPackQty(text) {
    if (!text) return 0;
    const patterns = [
        /pack\s*of\s*(\d+)/i,
        /(\d+)\s*[-]?\s*pack/i,
        /(\d+)\s*[-]?\s*count/i,
        /(\d+)\s*[-]?\s*ct\b/i,
        /(\d+)\s*[-]?\s*pk\b/i,
        /,\s*(\d+)\s*(?:pack|count|ct|pk)/i
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m) return parseInt(m[1], 10);
    }
    return 0;
}

function isMatchingProduct(mainTitle, mainShade, variantTitle, variantShade, longDesc) {
    if (!variantTitle) return false;

    const cleanLower = (t) => t.toLowerCase()
        .replace(/\d+(?:\.\d+)?\s*%/g, "")
        .replace(/[^\w\s.\/]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const cleanMain = cleanLower(mainTitle || "");
    const cleanMainShade = cleanLower(mainShade || "");
    const cleanVariant = cleanLower(variantTitle);
    const cleanVariantShade = cleanLower(variantShade || "");
    const cleanLongDesc = cleanLower(longDesc || "");

    const fullVariantText = `${cleanVariant} ${cleanVariantShade}`;

    // PRODUCT TYPE CHECK: Mini vs Regular products must match
    const mainIsMini = cleanMain.includes('mini');
    const variantIsMini = fullVariantText.includes('mini');
    if (mainIsMini !== variantIsMini) {
        return false;
    }

    // --- EXACT PHRASE MATCHING FOR COLORS/SHADES ---
    const extractColorPhrase = (text) => {
        const phrases = [];
        const shadeWithNumPattern = /\b([a-z]+\/[a-z]+)\s*-?\s*(\d{3})\b/gi;
        let match;
        while ((match = shadeWithNumPattern.exec(text)) !== null) {
            phrases.push(match[1].toLowerCase().trim());
            phrases.push(match[0].toLowerCase().trim());
        }

        const numShadePattern = /\b(\d{2,3})\s+([a-z]+(?:\s+[a-z]+)?)\b/gi;
        while ((match = numShadePattern.exec(text)) !== null) {
            phrases.push(match[0].toLowerCase().trim());
        }

        const slashPattern = /\b([a-z]+\/[a-z]+)\b/gi;
        while ((match = slashPattern.exec(text)) !== null) {
            const compound = match[1].toLowerCase();
            if (!phrases.includes(compound)) {
                phrases.push(compound);
            }
        }

        const ignoredTerms = [
            'cruelty free', 'oil free', 'fragrance free', 'paraben free',
            'gluten free', 'alcohol free', 'talc free', 'sugar free',
            'count', 'pack', 'pcs', 'ounce', 'oz', 'fl oz', 'metric'
        ];

        return phrases.filter(p => !ignoredTerms.some(term => p.includes(term)));
    };

    let refColorPhrases = extractColorPhrase(cleanLongDesc);
    if (refColorPhrases.length === 0) refColorPhrases = extractColorPhrase(cleanMain);
    if (refColorPhrases.length === 0) refColorPhrases = extractColorPhrase(cleanMainShade);

    const varColorPhrases = extractColorPhrase(fullVariantText);

    if (refColorPhrases.length > 0) {
        if (varColorPhrases.length === 0) return false;

        const refCompounds = refColorPhrases.filter(p => p.includes('/'));
        const refSingles = refColorPhrases.filter(p => !p.includes('/'));
        const varCompounds = varColorPhrases.filter(p => p.includes('/'));
        const varSingles = varColorPhrases.filter(p => !p.includes('/'));

        if (refCompounds.length > 0) {
            let foundMatch = false;
            for (const refComp of refCompounds) {
                if (varCompounds.some(vc => vc === refComp || vc.includes(refComp))) {
                    foundMatch = true;
                    break;
                }
            }
            if (!foundMatch) return false;
        }

        if (refCompounds.length === 0 && refSingles.length > 0) {
            for (const refSingle of refSingles) {
                if (!varSingles.includes(refSingle)) return false;
            }
        }
    }

    // --- SCENTS, SHAPES, SIZES ---
    const scentWords = ['lavender', 'vanilla', 'lemon', 'citrus', 'unscented', 'fresh', 'rose', 'ocean',
        'coconut', 'mint', 'eucalyptus', 'floral', 'linen', 'berry', 'pine', 'apple',
        'cucumber', 'melon', 'sandalwood', 'jasmine', 'chamomile'];
    const shapes = ['star', 'flower', 'round', 'square', 'oval', 'heart', 'hex', 'rectangle', 'diamond', 'triangle'];

    const extractItems = (text, list) => list.filter(i => text.includes(i));
    const extractSizes = (text) => {
        const sizes = [];
        const sizePatterns = [
            /(\d+\.?\d*)\s*(inch|in|")/gi, /(\d+\.?\d*)\s*(oz|ounce)/gi,
            /(\d+\.?\d*)\s*(qt|quart)/gi, /(\d+\.?\d*)\s*(l|liter)/gi,
            /(\d+\.?\d*)\s*(cup)/gi, /(\d+\.?\d*)\s*(piece|pc|pcs)/gi
        ];
        for (const pattern of sizePatterns) {
            let match;
            const regex = new RegExp(pattern.source, pattern.flags);
            while ((match = regex.exec(text)) !== null) sizes.push(match[1]);
        }
        return sizes;
    };

    let refScents = extractItems(cleanLongDesc, scentWords);
    if (refScents.length === 0) refScents = extractItems(cleanMain, scentWords);
    let refShapes = extractItems(cleanLongDesc, shapes);
    if (refShapes.length === 0) refShapes = extractItems(cleanMain, shapes);
    let refSizes = extractSizes(cleanLongDesc);
    if (refSizes.length === 0) refSizes = extractSizes(cleanMain);

    const varScents = extractItems(fullVariantText, scentWords);
    const varShapes = extractItems(fullVariantText, shapes);
    const varSizes = extractSizes(fullVariantText);

    const areAttributesEqual = (ref, varList) => {
        if (ref.length === 0) return true;
        if (varList.length === 0) return false;
        return [...ref].sort().join('|') === [...varList].sort().join('|');
    };

    if (refScents.length > 0 && !areAttributesEqual(refScents, varScents)) return false;
    if (refShapes.length > 0 && !areAttributesEqual(refShapes, varShapes)) return false;

    const extractIntegers = (text) => (text.match(/\b\d+\b/g) || []).map(Number);
    const filterMeaningfulNumbers = (text, sizes, packQty, colorPhrases) => {
        let nums = extractIntegers(text);
        if (packQty) nums = nums.filter(n => n !== packQty);
        const sizeNums = sizes.map(s => parseFloat(s));
        nums = nums.filter(n => !sizeNums.includes(n));
        for (const phrase of colorPhrases) {
            const phraseNums = phrase.match(/\b\d+\b/g) || [];
            phraseNums.forEach(pn => nums = nums.filter(n => n !== parseInt(pn, 10)));
        }
        return nums;
    };

    const refPackQty = extractPackQty(cleanLongDesc) || extractPackQty(cleanMain) || 1;
    const varPackQty = extractPackQty(fullVariantText) || 1;
    let refNums = filterMeaningfulNumbers(cleanLongDesc, refSizes, refPackQty, refColorPhrases);
    if (refNums.length === 0) refNums = filterMeaningfulNumbers(cleanMain, refSizes, refPackQty, refColorPhrases);
    const varNums = filterMeaningfulNumbers(fullVariantText, varSizes, varPackQty, varColorPhrases);

    if (refNums.length > 0 && refNums.find(n => !varNums.includes(n))) return false;
    if (refSizes.length > 0 && !areAttributesEqual(refSizes, varSizes)) return false;

    const productTypes = [
        'spoon', 'spatula', 'turner', 'ladle', 'whisk', 'tongs', 'fork',
        'knife', 'peeler', 'grater', 'slicer', 'masher', 'strainer', 'colander',
        'wok', 'pan', 'pot', 'skillet', 'griddle', 'saucepan', 'stockpot',
        'mitt', 'glove', 'holder', 'trivet', 'rack',
        'bowl', 'plate', 'cup', 'mug', 'glass', 'jar', 'container',
        'brush', 'scrubber', 'sponge', 'cleaner',
        'basting', 'slotted', 'solid', 'oversized', 'short', 'scraper',
        'cream', 'foundation', 'powder', 'concealer', 'lipstick', 'mascara'
    ];

    const longDescProducts = productTypes.filter(p => cleanLongDesc.includes(p));
    const variantProducts = productTypes.filter(p => fullVariantText.includes(p));

    if (longDescProducts.length > 0) {
        const intersection = longDescProducts.filter(p => variantProducts.includes(p));
        if (intersection.length / longDescProducts.length < 0.5) return false;
    }

    const ignore = ['the', 'and', 'for', 'with', 'of', 'in', 'to', 'see', 'available', 'options',
        'from', 'kitchen', 'safe', 'perfect', 'pack', 'count', 'ea', 'mini', 'premium',
        'stainless', 'steel', 'handle', 'nonstick', 'carbon', 'coated', 'durable'];
    const matchSource = cleanLongDesc.length > 5 ? cleanLongDesc : cleanMain;
    const allIgnore = [...ignore, ...productTypes, ...shapes];
    const matchWords = matchSource.split(' ').filter(w => w.length > 2 && !allIgnore.includes(w)).slice(0, 6);
    const matchCount = matchWords.filter(w => fullVariantText.includes(w)).length;

    return matchWords.length === 0 || matchCount / matchWords.length >= 0.6;
}

async function run(url, longDesc) {
    console.error(`Starting scrape for: ${url.substring(0, 80)}...`);

    const page = await getPageFromPool();

    try {
        console.error("Loading main page...");
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        
        // Shorter wait - just enough for content
        await sleep(1500);
        
        const hasContent = await detectBlocks(page);
        if (!hasContent) {
            throw new Error("Page loaded but no product content found");
        }

        console.error("Extracting variants from page...");
        const data = await page.evaluate(() => {
            const mainAsin = window.location.pathname.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
            const mainTitle = document.querySelector("#productTitle")?.textContent?.trim() || "";
            const allVariants = [];
            const seen = new Set();

            document.querySelectorAll("li[data-defaultasin]").forEach(li => {
                const asin = li.getAttribute("data-defaultasin");
                const label = li.textContent?.trim() || li.getAttribute("title") || "";
                if (asin && !seen.has(asin)) {
                    seen.add(asin);
                    allVariants.push({ asin, label: label.substring(0, 100) });
                }
            });

            document.querySelectorAll("[id^='variation_'] li").forEach(li => {
                const asin = li.getAttribute("data-defaultasin");
                const label = li.textContent?.trim() || "";
                if (asin && !seen.has(asin)) {
                    seen.add(asin);
                    allVariants.push({ asin, label: label.substring(0, 100) });
                }
            });

            document.querySelectorAll("script").forEach(s => {
                const text = s.textContent || "";
                const dvMatch = text.match(/dimensionValuesDisplayData[^{]*(\{[^}]+\})/);
                if (dvMatch) {
                    const asins = dvMatch[1].match(/[A-Z0-9]{10}/g) || [];
                    asins.forEach(asin => {
                        if (!seen.has(asin)) {
                            seen.add(asin);
                            allVariants.push({ asin, label: "from script" });
                        }
                    });
                }
                const avMatch = text.match(/asinVariationValues[^{]*(\{[^}]+\})/);
                if (avMatch) {
                    const asins = avMatch[1].match(/[A-Z0-9]{10}/g) || [];
                    asins.forEach(asin => {
                        if (!seen.has(asin)) {
                            seen.add(asin);
                            allVariants.push({ asin, label: "from script" });
                        }
                    });
                }
            });

            return { mainAsin, mainTitle, allVariants };
        });

        const results = [];
        const seenAsins = new Set([data.mainAsin]);

        const mainShade = await page.evaluate(() => {
            const colorRow = document.querySelector('tr.po-color, .po-color_name');
            if (colorRow) {
                const valueCell = colorRow.querySelector('td.po-break-word, span.po-break-word');
                if (valueCell) {
                    const text = valueCell.textContent?.trim() || "";
                    if (text) return text;
                }
            }

            const allRows = document.querySelectorAll('tr, .a-section');
            for (const row of allRows) {
                const text = row.textContent || "";
                if (text.toLowerCase().includes('color:')) {
                    const match = text.match(/color:\s*([^\n]+)/i);
                    if (match) return match[1].trim();
                }
            }

            const selected = document.querySelector('#variation_color_name .selection');
            if (selected) {
                const text = selected.textContent?.trim() || "";
                if (text && text !== "Select") return text;
            }
            return "";
        });

        results.push({
            asin: data.mainAsin,
            title: data.mainTitle,
            shade: mainShade,
            url: "https://www.amazon.com/dp/" + data.mainAsin,
            packQty: extractPackQty(data.mainTitle) || 1,
            isMain: true,
            notes: "Main product"
        });

        console.error(`Main: ${data.mainAsin} | Shade: ${mainShade}`);
        console.error(`Found ${data.allVariants.length} potential variants to check`);

        const checkVariant = async (v) => {
            if (v.asin === data.mainAsin || seenAsins.has(v.asin)) return null;
            seenAsins.add(v.asin);

            const p = await getPageFromPool();

            try {
                await p.goto(`https://www.amazon.com/dp/${v.asin}`, { 
                    waitUntil: "domcontentloaded", 
                    timeout: 25000 
                });

                await sleep(1000);

                const hasContent = await detectBlocks(p);
                if (!hasContent) {
                    await returnPageToPool(p);
                    return null;
                }

                const pageData = await p.evaluate(() => {
                    const title = document.querySelector("#productTitle")?.textContent?.trim() || "";
                    let shade = "";
                    const colorRow = document.querySelector('tr.po-color, .po-color_name');
                    if (colorRow) {
                        const valueCell = colorRow.querySelector('td.po-break-word, span.po-break-word');
                        if (valueCell) {
                            const text = valueCell.textContent?.trim() || "";
                            if (text) shade = text;
                        }
                    }

                    if (!shade) {
                        const allRows = document.querySelectorAll('tr, .a-section');
                        for (const row of allRows) {
                            const text = row.textContent || "";
                            if (text.toLowerCase().includes('color:')) {
                                const match = text.match(/color:\s*([^\n]+)/i);
                                if (match) {
                                    shade = match[1].trim();
                                    break;
                                }
                            }
                        }
                    }

                    if (!shade) {
                        const selected = document.querySelector('#variation_color_name .selection');
                        if (selected) {
                            const text = selected.textContent?.trim() || "";
                            if (text && text !== "Select") shade = text;
                        }
                    }
                    return { title, shade };
                });

                await returnPageToPool(p);

                if (!pageData.title) return null;

                let finalShade = pageData.shade;
                if (!finalShade && v.label && v.label !== "from script") {
                    finalShade = v.label;
                }

                if (!isMatchingProduct(data.mainTitle, mainShade, pageData.title, finalShade, longDesc)) return null;

                const packQty = extractPackQty(pageData.title) || 1;
                return { asin: v.asin, title: pageData.title, shade: finalShade, packQty };
            } catch (err) {
                await returnPageToPool(p);
                console.error(`  Error checking ${v.asin}: ${err.message}`);
                return null;
            }
        };

        // PARALLEL PROCESSING WITH CONCURRENCY LIMIT
        const BATCH_SIZE = 3;
        for (let i = 0; i < data.allVariants.length; i += BATCH_SIZE) {
            const batch = data.allVariants.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(checkVariant));
            
            batchResults.forEach(r => {
                if (r) {
                    results.push({
                        asin: r.asin,
                        title: r.title,
                        shade: r.shade,
                        url: "https://www.amazon.com/dp/" + r.asin,
                        packQty: r.packQty,
                        isMain: false,
                        notes: "Variant"
                    });
                    console.error(`  ✓ Added: ${r.asin} - Shade: ${r.shade}`);
                }
            });
            
            // Shorter delay between batches
            if (i + BATCH_SIZE < data.allVariants.length) {
                await sleep(800 + Math.random() * 400); // 0.8-1.2 seconds
            }
        }

        await returnPageToPool(page);

        const uniqueResults = [];
        const finalSeenAsins = new Set();
        for (const r of results) {
            if (!finalSeenAsins.has(r.asin)) {
                finalSeenAsins.add(r.asin);
                uniqueResults.push(r);
            }
        }

        uniqueResults.sort((a, b) => a.packQty - b.packQty);
        console.error(`\nDone! Found ${uniqueResults.length} unique products`);
        return uniqueResults;

    } catch (err) {
        await returnPageToPool(page);
        throw err;
    }
}

async function scrapeWithRetry(url, longDesc, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      return await run(url, longDesc);
    } catch (e) {
      console.error(`Attempt ${i} failed: ${e.message}`);
      
      if (e.message.includes("CAPTCHA") || e.message.includes("blocked") || e.message.includes("Cloudflare")) {
        console.error("⚠️ Detection triggered - closing browser for clean retry");
        await closeBrowser();
      }
      
      if (i === retries) {
        await closeBrowser();
        throw new Error(`All scraping attempts failed: ${e.message}`);
      }
      
      const delay = 4000 * i;
      console.error(`Waiting ${delay}ms before retry...`);
      await sleep(delay);
    }
  }
}

module.exports = async function scrapeHandler({ url, longDesc }) {
  if (!url) throw new Error("URL required");
  return await scrapeWithRetry(url, longDesc);
};
