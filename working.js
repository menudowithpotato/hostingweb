const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

let browser;

/* =========================
   BROWSER SINGLETON
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
      "--disable-blink-features=AutomationControlled"
    ]
  });

  return browser;
}

async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

// Clean shutdown handlers
process.on("SIGTERM", closeBrowser);
process.on("SIGINT", closeBrowser);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* =========================
   CAPTCHA / BLOCK DETECTION
========================= */
async function detectBlocks(page) {
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
}

/* =========================
   SAFE REQUEST INTERCEPTION
========================= */
function setupRequestInterception(page) {
  page.on('request', req => {
    try {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    } catch (err) {
      // Silently handle interception errors to prevent crashes
    }
  });
}

/* =========================
   RANDOM USER AGENT
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

    console.error(`    [DEBUG] Variant Full Text: "${fullVariantText.substring(0, 80)}"`);

    // PRODUCT TYPE CHECK: Mini vs Regular products must match
    const mainIsMini = cleanMain.includes('mini');
    const variantIsMini = fullVariantText.includes('mini');
    if (mainIsMini !== variantIsMini) {
        console.error(`    Rejected: Product type mismatch - main is ${mainIsMini ? 'mini' : 'regular'}, variant is ${variantIsMini ? 'mini' : 'regular'}`);
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

        return phrases.filter(p => {
            return !ignoredTerms.some(term => p.includes(term));
        });
    };

    let refColorPhrases = extractColorPhrase(cleanLongDesc);
    if (refColorPhrases.length === 0) refColorPhrases = extractColorPhrase(cleanMain);
    if (refColorPhrases.length === 0) refColorPhrases = extractColorPhrase(cleanMainShade);

    const varColorPhrases = extractColorPhrase(fullVariantText);

    console.error(`    [DEBUG] RefColorPhrases: [${refColorPhrases}]`);
    console.error(`    [DEBUG] VarColorPhrases: [${varColorPhrases}]`);

    if (refColorPhrases.length > 0) {
        if (varColorPhrases.length === 0) {
            console.error(`    Rejected: Ref requires specific shade [${refColorPhrases}], variant has NO shade info`);
            return false;
        }

        const refCompounds = refColorPhrases.filter(p => p.includes('/'));
        const refSingles = refColorPhrases.filter(p => !p.includes('/'));

        const varCompounds = varColorPhrases.filter(p => p.includes('/'));
        const varSingles = varColorPhrases.filter(p => !p.includes('/'));

        console.error(`    [DEBUG] RefCompounds: [${refCompounds}] | VarCompounds: [${varCompounds}]`);
        console.error(`    [DEBUG] RefSingles: [${refSingles}] | VarSingles: [${varSingles}]`);

        if (refCompounds.length > 0) {
            let foundMatch = false;
            for (const refComp of refCompounds) {
                if (varCompounds.some(vc => vc === refComp || vc.includes(refComp))) {
                    foundMatch = true;
                    break;
                }
            }

            if (!foundMatch) {
                console.error(`    Rejected: Required compound shade [${refCompounds}] not found in variant compounds [${varCompounds}]`);
                return false;
            }

            console.error(`    ✓ Exact compound shade match confirmed`);
        }

        if (refCompounds.length === 0 && refSingles.length > 0) {
            for (const refSingle of refSingles) {
                if (!varSingles.includes(refSingle)) {
                    console.error(`    Rejected: Required single shade "${refSingle}" not found in variant singles [${varSingles}]`);
                    return false;
                }
            }
            console.error(`    ✓ Exact single shade match confirmed`);
        }
    }

    // --- SCENTS ---
    const scentWords = [
        'lavender', 'vanilla', 'lemon', 'citrus', 'unscented', 'fresh', 'rose', 'ocean',
        'coconut', 'mint', 'eucalyptus', 'floral', 'linen', 'berry', 'pine', 'apple',
        'cucumber', 'melon', 'sandalwood', 'jasmine', 'chamomile'
    ];

    const shapes = ['star', 'flower', 'round', 'square', 'oval', 'heart', 'hex', 'rectangle', 'diamond', 'triangle'];

    const extractItems = (text, list) => list.filter(i => text.includes(i));
    const extractSizes = (text) => {
        const sizes = [];
        const sizePatterns = [
            /(\d+\.?\d*)\s*(inch|in|")/gi,
            /(\d+\.?\d*)\s*(oz|ounce)/gi,
            /(\d+\.?\d*)\s*(qt|quart)/gi,
            /(\d+\.?\d*)\s*(l|liter)/gi,
            /(\d+\.?\d*)\s*(cup)/gi,
            /(\d+\.?\d*)\s*(piece|pc|pcs)/gi
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

    console.error(`    [DEBUG] RefScents: [${refScents}] | VarScents: [${varScents}]`);
    console.error(`    [DEBUG] RefShapes: [${refShapes}] | VarShapes: [${varShapes}]`);
    console.error(`    [DEBUG] RefSizes:  [${refSizes}]  | VarSizes:  [${varSizes}]`);

    const areAttributesEqual = (ref, varList) => {
        if (ref.length === 0) return true;
        if (varList.length === 0) return false;
        const r = [...ref].sort().join('|');
        const v = [...varList].sort().join('|');
        return r === v;
    };

    if (refScents.length > 0) {
        if (!areAttributesEqual(refScents, varScents)) {
            console.error(`    Rejected: Scent mismatch - Ref [${refScents}], Var [${varScents}]`);
            return false;
        }
    }

    if (refShapes.length > 0) {
        if (!areAttributesEqual(refShapes, varShapes)) {
            console.error(`    Rejected: Shape mismatch - Ref [${refShapes}], Var [${varShapes}]`);
            return false;
        }
    }

    const extractIntegers = (text) => (text.match(/\b\d+\b/g) || []).map(Number);
    const filterMeaningfulNumbers = (text, sizes, packQty, colorPhrases) => {
        let nums = extractIntegers(text);
        if (packQty) nums = nums.filter(n => n !== packQty);
        const sizeNums = sizes.map(s => parseFloat(s));
        nums = nums.filter(n => !sizeNums.includes(n));

        for (const phrase of colorPhrases) {
            const phraseNums = phrase.match(/\b\d+\b/g) || [];
            phraseNums.forEach(pn => {
                nums = nums.filter(n => n !== parseInt(pn, 10));
            });
        }

        return nums;
    };

    const refPackQty = extractPackQty(cleanLongDesc) || extractPackQty(cleanMain) || 1;
    const varPackQty = extractPackQty(fullVariantText) || 1;

    let refNums = filterMeaningfulNumbers(cleanLongDesc, refSizes, refPackQty, refColorPhrases);
    if (refNums.length === 0) refNums = filterMeaningfulNumbers(cleanMain, refSizes, refPackQty, refColorPhrases);

    const varNums = filterMeaningfulNumbers(fullVariantText, varSizes, varPackQty, varColorPhrases);

    console.error(`    [DEBUG] RefNums: [${refNums}] | VarNums: [${varNums}]`);

    if (refNums.length > 0) {
        const missingNum = refNums.find(n => !varNums.includes(n));
        if (missingNum) {
            console.error(`    Rejected: Model Number mismatch - Ref required [${missingNum}], Var has [${varNums}]`);
            return false;
        }
    }

    if (refSizes.length > 0) {
        if (!areAttributesEqual(refSizes, varSizes)) {
            console.error(`    Rejected: Size mismatch - Ref [${refSizes}], Var [${varSizes}]`);
            return false;
        }
    }

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
        const matchRatio = intersection.length / longDescProducts.length;

        if (matchRatio < 0.5) {
            console.error(`    Rejected: Product type mismatch - LongDesc requires [${longDescProducts}], variant has [${variantProducts}]`);
            return false;
        }
        console.error(`    Product type match OK (${(matchRatio * 100).toFixed(0)}%)`);
    }

    const ignore = ['the', 'and', 'for', 'with', 'of', 'in', 'to', 'see', 'available', 'options',
        'from', 'kitchen', 'safe', 'perfect', 'pack', 'count', 'ea', 'mini', 'premium',
        'stainless', 'steel', 'handle', 'nonstick', 'carbon', 'coated', 'durable'];
    const matchSource = cleanLongDesc.length > 5 ? cleanLongDesc : cleanMain;
    const allIgnore = [...ignore, ...productTypes, ...shapes];
    const matchWords = matchSource.split(' ').filter(w => w.length > 2 && !allIgnore.includes(w)).slice(0, 6);
    const matchCount = matchWords.filter(w => fullVariantText.includes(w)).length;

    const matched = matchWords.length === 0 || matchCount / matchWords.length >= 0.6;
    if (!matched) {
        console.error(`    Rejected: Brand mismatch - only ${matchCount}/${matchWords.length} keywords matched`);
    } else {
        console.error(`    ✓ Accepted: Product, shade, and brand match OK`);
    }
    return matched;
}

async function run(url, longDesc) {
    console.error(`Starting scrape for: ${url.substring(0, 80)}...`);

    const browser = await getBrowser();
    const page = await browser.newPage();
    
    const ua = getRandomUserAgent();
    await page.setUserAgent(ua);
    console.error(`Using User-Agent: ${ua}`);
    
    await page.setDefaultNavigationTimeout(45000);
    await page.setRequestInterception(true);
    setupRequestInterception(page);

    try {
        console.error("Loading main page...");
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        
        // Check for blocks/captchas
        const hasContent = await detectBlocks(page);
        if (!hasContent) {
            throw new Error("Page loaded but no product content found");
        }

        await sleep(2000);

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

            const p = await browser.newPage();
            await p.setDefaultNavigationTimeout(25000);
            await p.setRequestInterception(true);
            setupRequestInterception(p);

            try {
                await p.goto(`https://www.amazon.com/dp/${v.asin}`, { 
                    waitUntil: "domcontentloaded", 
                    timeout: 25000 
                });

                // Check for blocks on variant pages too
                await detectBlocks(p);

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

                await p.close();

                if (!pageData.title) return null;

                let finalShade = pageData.shade;
                if (!finalShade && v.label && v.label !== "from script") {
                    finalShade = v.label;
                }

                console.error(`  Checking: ${v.asin} - Shade: "${finalShade}"`);

                if (!isMatchingProduct(data.mainTitle, mainShade, pageData.title, finalShade, longDesc)) return null;

                const packQty = extractPackQty(pageData.title) || 1;
                return { asin: v.asin, title: pageData.title, shade: finalShade, packQty };
            } catch (err) {
                try { await p.close(); } catch { }
                console.error(`  Error checking ${v.asin}: ${err.message}`);
                return null;
            }
        };

        for (let i = 0; i < data.allVariants.length; i += 3) {
            const batch = data.allVariants.slice(i, i + 3);
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
            await sleep(700);
        }

        await page.close();

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
        await page.close();
        throw err;
    }
}

async function scrapeWithRetry(url, longDesc, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      return await run(url, longDesc);
    } catch (e) {
      console.error(`Attempt ${i} failed: ${e.message}`);
      
      // If CAPTCHA/blocked, close browser to reset for next attempt
      if (e.message.includes("CAPTCHA") || e.message.includes("blocked") || e.message.includes("Cloudflare")) {
        console.error("⚠️ Detection triggered - closing browser for clean retry");
        await closeBrowser();
      }
      
      if (i === retries) {
        await closeBrowser();
        throw e;
      }
      
      // Exponential backoff for retries
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
