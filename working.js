const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

let browser;

async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });
  }
  return browser;
}

module.exports = {
  initBrowser
};


// Global timeout for the entire script (2 minutes max)
const SCRIPT_TIMEOUT = 120000;
let scriptTimer;

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
        .replace(/\d+(?:\.\d+)?\s*%/g, "") // Remove 100% etc
        .replace(/[^\w\s.\/]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const cleanMain = cleanLower(mainTitle || "");
    const cleanMainShade = cleanLower(mainShade || "");
    const cleanVariant = cleanLower(variantTitle);
    const cleanVariantShade = cleanLower(variantShade || "");
    const cleanLongDesc = cleanLower(longDesc || "");

    // Combine variant title + shade for complete matching
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

        // Pattern 1: "Light/Medium - 530" format (shade name + number)
        const shadeWithNumPattern = /\b([a-z]+\/[a-z]+)\s*-?\s*(\d{3})\b/gi;
        let match;
        while ((match = shadeWithNumPattern.exec(text)) !== null) {
            // Store both with and without number for flexible matching
            phrases.push(match[1].toLowerCase().trim()); // "light/medium"
            phrases.push(match[0].toLowerCase().trim()); // "light/medium - 530"
        }

        // Pattern 2: Number + Shade (e.g., "530 light medium", "050 deep")
        const numShadePattern = /\b(\d{2,3})\s+([a-z]+(?:\s+[a-z]+)?)\b/gi;
        while ((match = numShadePattern.exec(text)) !== null) {
            phrases.push(match[0].toLowerCase().trim());
        }

        // Pattern 3: Compound shades with slash (e.g., "light/medium", "medium/dark")
        const slashPattern = /\b([a-z]+\/[a-z]+)\b/gi;
        while ((match = slashPattern.exec(text)) !== null) {
            const compound = match[1].toLowerCase();
            if (!phrases.includes(compound)) {
                phrases.push(compound);
            }
        }

        // Filter out false positives (marketing terms that look like shades)
        const ignoredTerms = [
            'cruelty free', 'oil free', 'fragrance free', 'paraben free',
            'gluten free', 'alcohol free', 'talc free', 'sugar free',
            'count', 'pack', 'pcs', 'ounce', 'oz', 'fl oz', 'metric'
        ];

        return phrases.filter(p => {
            return !ignoredTerms.some(term => p.includes(term));
        });
    };

    // Extract exact color/shade phrases from LongDesc
    let refColorPhrases = extractColorPhrase(cleanLongDesc);
    if (refColorPhrases.length === 0) refColorPhrases = extractColorPhrase(cleanMain);
    if (refColorPhrases.length === 0) refColorPhrases = extractColorPhrase(cleanMainShade);

    // Extract from FULL variant text (title + shade attribute)
    const varColorPhrases = extractColorPhrase(fullVariantText);

    console.error(`    [DEBUG] RefColorPhrases: [${refColorPhrases}]`);
    console.error(`    [DEBUG] VarColorPhrases: [${varColorPhrases}]`);
    console.error(`    [DEBUG] FullVariantText: "${fullVariantText.substring(0, 100)}..."`);

    // STRICT MATCHING: If LongDesc specifies exact shade phrases, variant MUST match
    if (refColorPhrases.length > 0) {
        if (varColorPhrases.length === 0) {
            console.error(`    Rejected: Ref requires specific shade [${refColorPhrases}], variant has NO shade info`);
            return false;
        }

        // Find the PRIMARY compound shade in reference (e.g., "light/medium")
        const refCompounds = refColorPhrases.filter(p => p.includes('/'));
        const refSingles = refColorPhrases.filter(p => !p.includes('/'));

        // Find the PRIMARY compound shade in variant
        const varCompounds = varColorPhrases.filter(p => p.includes('/'));
        const varSingles = varColorPhrases.filter(p => !p.includes('/'));

        console.error(`    [DEBUG] RefCompounds: [${refCompounds}] | VarCompounds: [${varCompounds}]`);
        console.error(`    [DEBUG] RefSingles: [${refSingles}] | VarSingles: [${varSingles}]`);

        // If reference has compound shade (like "light/medium"), variant MUST have SAME compound
        if (refCompounds.length > 0) {
            let foundMatch = false;
            for (const refComp of refCompounds) {
                // Check if variant has this exact compound
                if (varCompounds.some(vc => vc === refComp || vc.includes(refComp))) {
                    foundMatch = true;
                    break;
                }
            }

            if (!foundMatch) {
                console.error(`    Rejected: Required compound shade [${refCompounds}] not found in variant compounds [${varCompounds}]`);
                return false;
            }

            console.error(`    ✓ Exact compound shade match confirmed: [${refCompounds}] matches [${varCompounds}]`);
        }

        // If reference has ONLY single shades, variant must match those
        if (refCompounds.length === 0 && refSingles.length > 0) {
            for (const refSingle of refSingles) {
                // Variant must have this single shade (not as part of compound)
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

    // --- SHAPES ---
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

    // Extract other attributes
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

    // Helper for STRICT SET EQUALITY
    const areAttributesEqual = (ref, varList) => {
        if (ref.length === 0) return true;
        if (varList.length === 0) return false;
        const r = [...ref].sort().join('|');
        const v = [...varList].sort().join('|');
        return r === v;
    };

    // Check Scent
    if (refScents.length > 0) {
        if (!areAttributesEqual(refScents, varScents)) {
            console.error(`    Rejected: Scent mismatch - Ref [${refScents}], Var [${varScents}]`);
            return false;
        }
    }

    // Check Shape
    if (refShapes.length > 0) {
        if (!areAttributesEqual(refShapes, varShapes)) {
            console.error(`    Rejected: Shape mismatch - Ref [${refShapes}], Var [${varShapes}]`);
            return false;
        }
    }

    // --- MODEL/SHADE NUMBERS CHECK ---
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

    // Check Size
    if (refSizes.length > 0) {
        if (!areAttributesEqual(refSizes, varSizes)) {
            console.error(`    Rejected: Size mismatch - Ref [${refSizes}], Var [${varSizes}]`);
            return false;
        }
    }

    // KEY PRODUCT TYPE WORDS
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
            console.error(`    Rejected: Product type mismatch - LongDesc requires [${longDescProducts}], variant has [${variantProducts}] (Match: ${(matchRatio * 100).toFixed(0)}%)`);
            return false;
        }
        console.error(`    Product type match: [${longDescProducts}] vs [${variantProducts}] (${(matchRatio * 100).toFixed(0)}%)`);
    }

    // Brand keyword matching
    const ignore = ['the', 'and', 'for', 'with', 'of', 'in', 'to', 'see', 'available', 'options',
        'from', 'kitchen', 'safe', 'perfect', 'pack', 'count', 'ea', 'mini', 'premium',
        'stainless', 'steel', 'handle', 'nonstick', 'carbon', 'coated', 'durable'];
    const matchSource = cleanLongDesc.length > 5 ? cleanLongDesc : cleanMain;
    const allIgnore = [...ignore, ...productTypes, ...shapes];
    const matchWords = matchSource.split(' ').filter(w => w.length > 2 && !allIgnore.includes(w)).slice(0, 6);
    const matchCount = matchWords.filter(w => fullVariantText.includes(w)).length;

    const matched = matchWords.length === 0 || matchCount / matchWords.length >= 0.6;
    if (!matched) {
        console.error(`    Rejected: Brand mismatch - only ${matchCount}/${matchWords.length} keywords matched: [${matchWords}]`);
    } else {
        console.error(`    Accepted: Product, shade, and brand match OK`);
    }
    return matched;
}


async function run(url, longDesc) {
    console.error(`Starting scrape for: ${url.substring(0, 80)}...`);

    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
    });

    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(15000);
    await page.setRequestInterception(true);
    page.on('request', req => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");

    try {
        console.error("Loading main page...");
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    } catch (err) {
        console.error("Failed to load page:", err.message);
        await browser.close();
        return [];
    }

    await new Promise(r => setTimeout(r, 1500));

    console.error("Extracting variants from page...");
    const data = await page.evaluate(() => {
        const mainAsin = window.location.pathname.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
        const mainTitle = document.querySelector("#productTitle")?.textContent?.trim() || "";
        const allVariants = [];
        const seen = new Set();

        // Method 1: All li[data-defaultasin] elements (these often have shade labels)
        document.querySelectorAll("li[data-defaultasin]").forEach(li => {
            const asin = li.getAttribute("data-defaultasin");
            const label = li.textContent?.trim() || li.getAttribute("title") || "";
            if (asin && !seen.has(asin)) {
                seen.add(asin);
                allVariants.push({ asin, label: label.substring(0, 100) });
            }
        });

        // Method 2: Twister dimensions
        document.querySelectorAll("[id^='variation_'] li").forEach(li => {
            const asin = li.getAttribute("data-defaultasin");
            const label = li.textContent?.trim() || "";
            if (asin && !seen.has(asin)) {
                seen.add(asin);
                allVariants.push({ asin, label: label.substring(0, 100) });
            }
        });

        // Method 3: From scripts
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

    // Get main product shade info - try multiple methods
    const mainShade = await page.evaluate(() => {
        // Method 1: Product info table (where "Color: Light/Medium - 530" appears)
        const colorRow = document.querySelector('tr.po-color, .po-color_name');
        if (colorRow) {
            const valueCell = colorRow.querySelector('td.po-break-word, span.po-break-word');
            if (valueCell) {
                const text = valueCell.textContent?.trim() || "";
                if (text) return text;
            }
        }

        // Method 2: Look for "Color:" label in product details
        const allRows = document.querySelectorAll('tr, .a-section');
        for (const row of allRows) {
            const text = row.textContent || "";
            if (text.toLowerCase().includes('color:')) {
                // Extract text after "Color:"
                const match = text.match(/color:\s*([^\n]+)/i);
                if (match) return match[1].trim();
            }
        }

        // Method 3: Look for selected variation in twister
        const selected = document.querySelector('#variation_color_name .selection');
        if (selected) {
            const text = selected.textContent?.trim() || "";
            if (text && text !== "Select") return text;
        }

        // Method 4: Check inline "Color: " text in page
        const pageText = document.body.textContent || "";
        const colorMatch = pageText.match(/Color:\s*([^\n]{3,50})/i);
        if (colorMatch) return colorMatch[1].trim();

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

    console.error(`Main: ${data.mainAsin} | Title: ${data.mainTitle.substring(0, 50)}... | Shade: ${mainShade}`);
    console.error(`Found ${data.allVariants.length} potential variants to check`);

    const checkVariant = async (v) => {
        if (v.asin === data.mainAsin || seenAsins.has(v.asin)) return null;
        seenAsins.add(v.asin);

        const p = await browser.newPage();
        await p.setDefaultNavigationTimeout(8000);
        await p.setRequestInterception(true);
        p.on('request', req => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        try {
            await p.goto(`https://www.amazon.com/dp/${v.asin}`, { waitUntil: "domcontentloaded", timeout: 8000 });

            // Get both title AND shade from variation selector - try multiple methods
            const pageData = await p.evaluate(() => {
                const title = document.querySelector("#productTitle")?.textContent?.trim() || "";

                // Method 1: Product info table (most reliable - "Color: Light/Medium - 530")
                let shade = "";
                const colorRow = document.querySelector('tr.po-color, .po-color_name');
                if (colorRow) {
                    const valueCell = colorRow.querySelector('td.po-break-word, span.po-break-word');
                    if (valueCell) {
                        const text = valueCell.textContent?.trim() || "";
                        if (text) shade = text;
                    }
                }

                // Method 2: Look for "Color:" in all table rows
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

                // Method 3: Selected variation
                if (!shade) {
                    const selected = document.querySelector('#variation_color_name .selection');
                    if (selected) {
                        const text = selected.textContent?.trim() || "";
                        if (text && text !== "Select") shade = text;
                    }
                }

                // Method 4: Product details table
                if (!shade) {
                    const detailRows = document.querySelectorAll('.po-color_name .po-break-word, .po-shade .po-break-word');
                    for (const row of detailRows) {
                        const text = row.textContent?.trim() || "";
                        if (text) {
                            shade = text;
                            break;
                        }
                    }
                }

                return { title, shade };
            });

            await p.close();

            if (!pageData.title) return null;

            // Fallback: If shade is still empty, use the label from variant list
            let finalShade = pageData.shade;
            if (!finalShade && v.label && v.label !== "from script") {
                finalShade = v.label;
            }

            console.error(`  Checking: ${v.asin} - "${pageData.title.substring(0, 30)}..." Shade: "${finalShade}"`);

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
    }

    await browser.close();

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
}

async function scrapeWithRetry(url, longDesc, retries = 3, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await run(url, longDesc);
    } catch (err) {
      console.warn(`Attempt ${i+1} failed. Retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("All scraping attempts failed");
}

module.exports = async function scrapeHandler({ url, longDesc }) {
  return await scrapeWithRetry(url, longDesc);
};



