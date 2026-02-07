const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { buildSearchUrl, convertToCSV, COUNTRY_CODES } = require("./scraper");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const COOKIES_PATH = path.join(__dirname, "cookies.json");

function loadCookies() {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf-8"));
      if (Array.isArray(cookies) && cookies.length > 0) {
        return cookies;
      }
    }
  } catch {}
  return null;
}

function randomDelay(min = 500, max = 1500) {
  return new Promise((resolve) =>
    setTimeout(resolve, min + Math.random() * (max - min))
  );
}

/**
 * Navigate nested object to find search_results_connection.
 * Handles multiple Facebook response formats.
 */
function findSearchResults(obj, depth = 0) {
  if (depth > 15 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = findSearchResults(item, depth + 1);
      if (result) return result;
    }
    return null;
  }

  for (const key of ["search_results_connection", "search_results", "results"]) {
    if (obj[key] && typeof obj[key] === "object" && obj[key].edges) {
      return obj[key];
    }
  }

  if (obj.edges && Array.isArray(obj.edges) && obj.edges.length > 0) {
    const firstNode = obj.edges[0]?.node;
    if (firstNode) {
      if (firstNode.ad_archive_id || firstNode.adArchiveID || firstNode.adArchiveId) {
        return obj;
      }
      if (firstNode.collated_results && Array.isArray(firstNode.collated_results)) {
        return obj;
      }
    }
  }

  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === "object" && obj[key] !== null) {
      const result = findSearchResults(obj[key], depth + 1);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Extract edges array and page_info from a connection object.
 * Handles the collated_results format where each edge.node contains
 * a collated_results[] array of actual ads.
 */
function extractEdgesAndPageInfo(connection) {
  const rawEdges = connection.edges || [];
  const pageInfo =
    connection.page_info ||
    connection.pageInfo ||
    connection.page_info_result || {};
  const count = connection.count || connection.total_count || 0;

  const firstNode = rawEdges[0]?.node;
  if (firstNode?.collated_results && Array.isArray(firstNode.collated_results)) {
    const flatEdges = [];
    for (const edge of rawEdges) {
      const collated = edge.node?.collated_results || [];
      for (const ad of collated) {
        flatEdges.push({ node: ad });
      }
    }
    return { edges: flatEdges, pageInfo, count };
  }

  return { edges: rawEdges, pageInfo, count };
}

/**
 * Process GraphQL response text into edges.
 * Handles multi-line JSON format.
 */
function processGraphQLResponse(responseText) {
  const lines = responseText.split("\n").filter((l) => l.trim());
  let bestEdges = [];
  let bestPageInfo = null;
  let bestCount = 0;

  for (const line of lines) {
    try {
      const json = JSON.parse(line);
      const connection = findSearchResults(json);
      if (connection) {
        const result = extractEdgesAndPageInfo(connection);
        if (result.edges.length > bestEdges.length) {
          bestEdges = result.edges;
          bestPageInfo = result.pageInfo;
          bestCount = result.count || bestCount;
        }
      }
    } catch {}
  }

  return { edges: bestEdges, pageInfo: bestPageInfo, count: bestCount };
}

/**
 * Normalize a raw GraphQL ad node into our app's data model.
 */
function normalizeAd(edge) {
  const node = edge.node || edge;
  if (!node) return null;

  const adId = node.ad_archive_id || node.adArchiveID;
  if (!adId) return null;

  const snapshot = node.snapshot || {};
  const isActive = node.is_active ?? node.isActive;

  const startDate = formatUnixDate(node.start_date || node.startDate);
  const endDate = formatUnixDate(node.end_date || node.endDate);

  const adBody =
    snapshot.body?.text ||
    snapshot.cards?.[0]?.body ||
    node.ad_creative_bodies?.[0] ||
    null;

  const title =
    snapshot.title ||
    snapshot.cards?.[0]?.title ||
    node.ad_creative_link_titles?.[0] ||
    null;

  const ctaText = snapshot.cta_text || snapshot.cards?.[0]?.cta_text || null;
  const ctaUrl = snapshot.link_url || snapshot.cards?.[0]?.link_url || null;

  const images = [];
  if (snapshot.images && Array.isArray(snapshot.images)) {
    for (const img of snapshot.images) {
      if (img.original_image_url || img.resized_image_url) {
        images.push({
          src: img.original_image_url || img.resized_image_url,
          alt: "",
          width: img.width || 0,
          height: img.height || 0,
        });
      }
    }
  }
  if (snapshot.cards && Array.isArray(snapshot.cards)) {
    for (const card of snapshot.cards) {
      if (card.original_image_url || card.resized_image_url) {
        images.push({
          src: card.original_image_url || card.resized_image_url,
          alt: "",
          width: card.image_width || 0,
          height: card.image_height || 0,
        });
      }
    }
  }

  const videos = [];
  if (snapshot.videos && Array.isArray(snapshot.videos)) {
    for (const vid of snapshot.videos) {
      if (vid.video_sd_url || vid.video_hd_url) {
        videos.push({
          src: vid.video_hd_url || vid.video_sd_url,
          poster: vid.video_preview_image_url || "",
        });
      }
    }
  }

  const platforms = node.publisher_platform || node.publisherPlatforms || [];
  const spend = node.spend || null;
  const impressions = node.impressions_with_index || node.impressions || null;

  const advertiserName = node.page_name || node.pageName || snapshot.page_name || null;
  const advertiserUrl = snapshot.page_profile_uri || null;
  const pageId = node.page_id || node.pageId || snapshot.page_id || null;

  return {
    libraryId: String(adId),
    status: isActive === true ? "Active" : isActive === false ? "Inactive" : "Unknown",
    startDate,
    endDate,
    advertiserName,
    advertiserUrl,
    coAdvertiser: null,
    adBody,
    gqlTitle: title,
    ctaUrl,
    ctaText,
    creativeCount: node.collation_count || 1,
    hasMultipleVersions: (node.collation_count || 1) > 1,
    isAgeGated: node.gated_type === "AGE_GATED",
    images,
    videos,
    platforms,
    spend,
    impressions,
    currency: node.currency || null,
    categories: node.categories || [],
    gatedType: node.gated_type || null,
    pageId,
    collationId: node.collation_id || null,
    displayFormat: snapshot.display_format || null,
    caption: snapshot.caption || null,
  };
}

function formatUnixDate(timestamp) {
  if (!timestamp) return null;
  const ts = typeof timestamp === "string" ? parseInt(timestamp) : timestamp;
  if (isNaN(ts) || ts === 0) return null;
  try {
    return new Date(ts * 1000).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return null;
  }
}

function getExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).replace(".", "").split("?")[0];
    return ext || null;
  } catch {
    return null;
  }
}

/**
 * DOM-based fallback: extract ad data from rendered page when GraphQL is rate limited.
 * Parses ad links, text content, and images directly from the DOM.
 */
async function extractAdsFromDOM(page, log) {
  return page.evaluate(() => {
    const ads = [];
    // Find all ad library links with IDs
    const adLinks = document.querySelectorAll('a[href*="/ads/library/?id="]');
    const seenIds = new Set();

    for (const link of adLinks) {
      const href = link.getAttribute("href") || "";
      const match = href.match(/[?&]id=(\d+)/);
      if (!match) continue;
      const adId = match[1];
      if (seenIds.has(adId)) continue;
      seenIds.add(adId);

      // Walk up to find the ad container (usually a parent with role="article" or a card-like container)
      let container = link.closest('[role="article"]') || link.parentElement?.parentElement?.parentElement?.parentElement?.parentElement;

      const ad = {
        libraryId: adId,
        status: "Active",
        startDate: null,
        endDate: null,
        advertiserName: null,
        advertiserUrl: null,
        coAdvertiser: null,
        adBody: null,
        gqlTitle: null,
        ctaUrl: null,
        ctaText: null,
        creativeCount: 1,
        hasMultipleVersions: false,
        isAgeGated: false,
        images: [],
        videos: [],
        platforms: [],
        spend: null,
        impressions: null,
        currency: null,
        categories: [],
        gatedType: null,
        pageId: null,
        collationId: null,
        displayFormat: null,
        caption: null,
      };

      if (container) {
        // Try to find advertiser name (usually in a link near the top of the card)
        const pageLinks = container.querySelectorAll('a[href*="/ads/library/?active_status"]');
        for (const pl of pageLinks) {
          const text = pl.textContent?.trim();
          if (text && text.length > 1 && !text.includes("Ad Library")) {
            ad.advertiserName = text;
            break;
          }
        }

        // Get text content - look for the ad body
        const textElements = container.querySelectorAll('div[style*="webkit-line-clamp"], span[class]');
        for (const el of textElements) {
          const text = el.textContent?.trim();
          if (text && text.length > 20 && !ad.adBody) {
            ad.adBody = text;
          }
        }

        // Get images
        const imgs = container.querySelectorAll('img[src*="scontent"], img[src*="fbcdn"]');
        for (const img of imgs) {
          const src = img.getAttribute("src");
          if (src && !src.includes("profile") && !src.includes("emoji")) {
            ad.images.push({
              src,
              alt: img.getAttribute("alt") || "",
              width: img.naturalWidth || 0,
              height: img.naturalHeight || 0,
            });
          }
        }

        // Get videos
        const vids = container.querySelectorAll("video source, video[src]");
        for (const vid of vids) {
          const src = vid.getAttribute("src");
          if (src) {
            ad.videos.push({ src, poster: "" });
          }
        }

        // Get dates - look for "Started running on" text
        const allText = container.textContent || "";
        const dateMatch = allText.match(/Started running on\s+(.+?)(?:\s*·|\s*$)/);
        if (dateMatch) {
          ad.startDate = dateMatch[1].trim();
        }
      }

      ads.push(ad);
    }
    return ads;
  });
}

/**
 * Extract media URLs from the rendered DOM and map them to ad IDs.
 * Returns a Map of libraryId -> { images: [], videos: [] }
 * Used to fill in media for ads where GraphQL didn't include snapshot data
 * (e.g. gatedType: "LOGGED_OUT").
 */
async function extractMediaFromDOM(page) {
  return page.evaluate(() => {
    const mediaMap = {};
    const adLinks = document.querySelectorAll('a[href*="/ads/library/?id="]');
    const seenIds = new Set();

    for (const link of adLinks) {
      const href = link.getAttribute("href") || "";
      const match = href.match(/[?&]id=(\d+)/);
      if (!match) continue;
      const adId = match[1];
      if (seenIds.has(adId)) continue;
      seenIds.add(adId);

      const container =
        link.closest('[role="article"]') ||
        link.parentElement?.parentElement?.parentElement?.parentElement?.parentElement;
      if (!container) continue;

      const images = [];
      const imgs = container.querySelectorAll('img[src*="scontent"], img[src*="fbcdn"]');
      for (const img of imgs) {
        const src = img.getAttribute("src");
        if (src && !src.includes("profile") && !src.includes("emoji") && !src.includes("_s.")) {
          images.push({
            src,
            alt: img.getAttribute("alt") || "",
            width: img.naturalWidth || 0,
            height: img.naturalHeight || 0,
          });
        }
      }

      const videos = [];
      const vidSources = container.querySelectorAll("video source, video[src]");
      for (const vid of vidSources) {
        const src = vid.getAttribute("src");
        if (src) {
          const poster = vid.closest("video")?.getAttribute("poster") || "";
          videos.push({ src, poster });
        }
      }

      if (images.length > 0 || videos.length > 0) {
        mediaMap[adId] = { images, videos };
      }
    }
    return mediaMap;
  });
}

/**
 * Main scraper function - uses browser for all pagination.
 * Opens browser, navigates to Ad Library, scrolls to load ads via
 * intercepted GraphQL responses. No external fetch() needed.
 */
async function scrapeAdsGraphQL(params, onProgress, { signal } = {}) {
  const {
    query,
    country = "US",
    activeStatus = "active",
    adType = "all",
    mediaType = "all",
    sortBy = "impressions",
    maxAds = 50,
    downloadMedia = false,
    outputDir = path.join(process.cwd(), "output"),
    previouslySeenIds = [],
  } = params;

  function checkAborted() {
    if (signal && signal.aborted) {
      const err = new Error("Scrape cancelled");
      err.name = "AbortError";
      throw err;
    }
  }

  const log = (msg) => {
    console.log(`[graphql-scraper] ${msg}`);
    if (onProgress) onProgress({ type: "log", message: msg });
  };

  const searchParams = { query, country, activeStatus, adType, mediaType, sortBy };
  const url = buildSearchUrl(searchParams);
  log(`Search URL: ${url}`);

  // All collected ads
  const allAds = [];
  const seenIds = new Set(previouslySeenIds);
  const isResuming = previouslySeenIds.length > 0;

  if (isResuming) {
    log(`Resume mode: ${previouslySeenIds.length} previously scraped ads will be skipped`);
  }

  function addAdsFromEdges(edges) {
    let newCount = 0;
    for (const edge of edges) {
      const ad = normalizeAd(edge);
      if (ad && !seenIds.has(ad.libraryId)) {
        seenIds.add(ad.libraryId);
        allAds.push(ad);
        newCount++;
      }
    }
    return newCount;
  }

  log("Launching browser...");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--disable-extensions",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    // Load saved Facebook cookies for authenticated access
    const cookies = loadCookies();
    if (cookies) {
      await context.addCookies(cookies);
      log("Loaded Facebook session cookies (authenticated mode)");
    } else {
      log("No cookies.json found — running unauthenticated (age-gated ads will have no media)");
    }

    const page = await context.newPage();

    // Queue for new GraphQL responses (used to detect when new data arrives)
    let pendingResponses = [];
    let responseSeq = 0;

    // Request budget tracking — warn when approaching limits
    let gqlRequestCount = 0;
    let gqlRequestWindowStart = Date.now();
    function trackRequest() {
      const now = Date.now();
      // Reset counter every hour
      if (now - gqlRequestWindowStart > 3600000) {
        gqlRequestCount = 0;
        gqlRequestWindowStart = now;
      }
      gqlRequestCount++;
      if (gqlRequestCount === 150) {
        log(`Warning: ${gqlRequestCount} GraphQL requests in the last hour, approaching limits`);
      } else if (gqlRequestCount === 190) {
        log(`Critical: ${gqlRequestCount} GraphQL requests in the last hour, very close to rate limit`);
      }
    }

    let rateLimitCount = 0;
    let rateLimited = false;
    // Track which GraphQL calls are ad-search related vs unrelated (analytics, logging, etc.)
    const AD_SEARCH_INDICATORS = [
      "AdLibrarySearchPage",
      "AdLibraryMobileFocusedStateProvider",
      "SearchResultsConnection",
      "search_results_connection",
      "ad_library_search",
      "adLibrarySearch",
      "useAdLibrary",
      "ad_archive",
      "collated_results",
    ];

    page.on("response", async (response) => {
      try {
        const rUrl = response.url();
        if (!rUrl.includes("/api/graphql")) return;
        trackRequest();

        const status = response.status();

        // HTTP 429 = explicit rate limit (applies globally)
        if (status === 429) {
          rateLimitCount++;
          rateLimited = true;
          if (rateLimitCount === 1) log("Rate limit detected (HTTP 429)");
          return;
        }

        if (status !== 200) return;

        const body = await response.text();
        if (!body) return;

        // Only check for rate limit errors in ad-search-related responses.
        // Facebook pages make dozens of unrelated GraphQL calls where error
        // strings like "try again later" are normal and NOT rate limits.
        const isAdSearchResponse = AD_SEARCH_INDICATORS.some((indicator) =>
          body.includes(indicator)
        );

        if (isAdSearchResponse) {
          if (
            body.includes("Rate limit exceeded") ||
            body.includes('"code":1675004')
          ) {
            rateLimitCount++;
            if (rateLimitCount === 1) {
              log("Rate limit detected from ad search API");
            }
            rateLimited = true;
            return;
          }
          rateLimited = false;
        }

        // Always try to extract ad data from every GraphQL response,
        // regardless of whether it matched indicator strings
        const { edges, pageInfo, count } = processGraphQLResponse(body);
        if (edges.length > 0) {
          pendingResponses.push({ edges, pageInfo, count, seq: ++responseSeq });
        }
      } catch {}
    });

    // Navigate
    log("Navigating to Ad Library page...");
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

    // Dismiss cookie consent
    try {
      const consentBtn = page.locator(
        '[data-cookiebanner="accept_button"], ' +
        '[data-testid="cookie-policy-manage-dialog-accept-button"], ' +
        'button:has-text("Allow all cookies"), ' +
        'button:has-text("Allow essential and optional cookies"), ' +
        'button:has-text("Decline optional cookies")'
      ).first();
      if (await consentBtn.isVisible({ timeout: 2000 })) {
        await consentBtn.click();
        log("Dismissed cookie consent dialog");
        await page.waitForLoadState("networkidle", { timeout: 15000 });
      }
    } catch {}

    // Wait for ad content
    try {
      await page.waitForSelector(
        'div[role="article"], div[class*="xrvj5dj"], a[href*="/ads/library/?id="]',
        { timeout: 15000 }
      );
      log("Ad content detected on page");
    } catch {
      log("No ad content selector found, continuing anyway...");
    }

    // Wait for initial GraphQL responses to arrive
    await page.waitForTimeout(3000);

    // Process any initial responses
    for (const resp of pendingResponses) {
      const newCount = addAdsFromEdges(resp.edges);
      if (newCount > 0) {
        log(`Initial load: +${newCount} ads (total: ${allAds.length})`);
      }
    }
    pendingResponses = [];

    if (onProgress) {
      onProgress({ type: "progress", current: allAds.length, max: maxAds });
    }

    log(`Initial: ${allAds.length} ads from page load`);

    // If no ads from GraphQL, try DOM extraction immediately
    // The page often renders ads via SSR even when GraphQL is blocked
    if (allAds.length === 0) {
      log("No ads from GraphQL interception, trying DOM extraction...");
      // Debug: check what's actually on the page
      const debugInfo = await page.evaluate(() => {
        const articles = document.querySelectorAll('div[role="article"]').length;
        const adLinks = document.querySelectorAll('a[href*="/ads/library/?id="]').length;
        const allAdLinks = document.querySelectorAll('a[href*="ads/library"]').length;
        // Sample the actual hrefs to see the URL format
        const sampleHrefs = [...document.querySelectorAll('a[href*="ads/library"]')]
          .slice(0, 5)
          .map(a => a.getAttribute("href"));
        return { articles, adLinks, allAdLinks, sampleHrefs, url: location.href };
      });
      log(`DOM debug: ${debugInfo.articles} articles, ${debugInfo.adLinks} ad ID links, ${debugInfo.allAdLinks} ad library links`);
      log(`DOM debug: sample hrefs: ${JSON.stringify(debugInfo.sampleHrefs)}`);
      const domAds = await extractAdsFromDOM(page, log);
      for (const ad of domAds) {
        if (!seenIds.has(ad.libraryId)) {
          seenIds.add(ad.libraryId);
          allAds.push(ad);
        }
      }
      if (domAds.length > 0) {
        log(`DOM extraction: found ${allAds.length} ads from rendered page`);
        if (onProgress) onProgress({ type: "progress", current: allAds.length, max: maxAds });
      }
    }

    // If still nothing and rate limited, retry with backoff
    if (rateLimited && allAds.length === 0) {
      const maxRetries = 2;
      const baseDelay = 30;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const delaySec = baseDelay * Math.pow(2, attempt - 1); // 30s, 60s
        log(`Rate limited, no ads found (attempt ${attempt}/${maxRetries}), waiting ${delaySec}s...`);
        if (onProgress) onProgress({ type: "log", message: `Rate limited by Facebook, retrying in ${delaySec}s...` });
        await page.waitForTimeout(delaySec * 1000);
        rateLimitCount = 0;
        rateLimited = false;
        await page.reload({ waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(5000);

        // Try GraphQL first
        for (const resp of pendingResponses) {
          const newCount = addAdsFromEdges(resp.edges);
          if (newCount > 0) {
            log(`Retry ${attempt}: +${newCount} ads from GraphQL (total: ${allAds.length})`);
          }
        }
        pendingResponses = [];

        // Then try DOM
        if (allAds.length === 0) {
          const domAds = await extractAdsFromDOM(page, log);
          for (const ad of domAds) {
            if (!seenIds.has(ad.libraryId)) {
              seenIds.add(ad.libraryId);
              allAds.push(ad);
            }
          }
          if (allAds.length > 0) {
            log(`Retry ${attempt}: +${allAds.length} ads from DOM extraction`);
          }
        }

        if (onProgress) {
          onProgress({ type: "progress", current: allAds.length, max: maxAds });
        }

        if (allAds.length > 0 || !rateLimited) break;
      }

      if (allAds.length === 0) {
        log("All retries failed — no ads found.");
        throw new Error("Facebook rate limit: could not load any ads. Try again later.");
      }
    }

    // Pagination loop: scroll to load more ads
    let emptyScrolls = 0; // scrolls with zero GraphQL edges at all (truly exhausted)
    let noNewAdsScrolls = 0; // scrolls with edges, but all already in seenIds
    const maxEmptyScrolls = 5;
    const maxNoNewAdsScrolls = isResuming ? 15 : 5;
    let scrollCount = 0;
    let consecutiveRateLimits = 0;

    while (allAds.length < maxAds && emptyScrolls < maxEmptyScrolls && noNewAdsScrolls < maxNoNewAdsScrolls) {
      checkAborted();
      scrollCount++;
      const prevCount = allAds.length;
      const prevSeq = responseSeq;

      // If rate limited, try DOM extraction instead of long backoff
      if (rateLimited) {
        consecutiveRateLimits++;
        if (consecutiveRateLimits >= 3) {
          log("Persistent rate limiting, switching to DOM-only extraction...");
          // Try one final DOM extraction before stopping
          const domAds = await extractAdsFromDOM(page, log);
          for (const ad of domAds) {
            if (!seenIds.has(ad.libraryId)) {
              seenIds.add(ad.libraryId);
              allAds.push(ad);
            }
          }
          if (domAds.length > 0) {
            log(`DOM fallback during pagination: +${domAds.length} ads`);
          }
          break;
        }
        const backoffSec = 30 * Math.pow(2, consecutiveRateLimits - 1); // 30s, 60s
        log(`Rate limited, backing off ${backoffSec}s (retry ${consecutiveRateLimits}/3)...`);
        checkAborted();
        await page.waitForTimeout(backoffSec * 1000);
        rateLimited = false;
      } else {
        consecutiveRateLimits = 0;
      }

      // Scroll to bottom
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await randomDelay(3000, 6000);

      // Try clicking "See more results" button if visible
      try {
        const seeMore = page.locator(
          'div[role="button"]:has-text("See more results"), ' +
          'button:has-text("See more")'
        ).first();
        if (await seeMore.isVisible({ timeout: 1000 })) {
          await seeMore.click();
          log("Clicked 'See more results'");
        }
      } catch {}

      // Wait for new response or timeout
      const waitStart = Date.now();
      while (responseSeq === prevSeq && Date.now() - waitStart < 8000) {
        await page.waitForTimeout(500);
      }

      // Small extra wait for response processing
      await page.waitForTimeout(500);

      // Process new responses — track whether any edges arrived at all
      let scrollHadEdges = false;
      for (const resp of pendingResponses) {
        if (resp.edges.length > 0) scrollHadEdges = true;
        addAdsFromEdges(resp.edges);
      }
      pendingResponses = [];

      const newAds = allAds.length - prevCount;
      if (newAds > 0) {
        log(`Scroll ${scrollCount}: +${newAds} ads (total: ${allAds.length}/${maxAds})`);
        emptyScrolls = 0;
        noNewAdsScrolls = 0;
      } else if (scrollHadEdges) {
        // Got edges but all were previously seen — only relevant in resume mode
        noNewAdsScrolls++;
        emptyScrolls = 0;
        log(`Scroll ${scrollCount}: all ads already seen (${noNewAdsScrolls}/${maxNoNewAdsScrolls} skipped scrolls)`);
      } else {
        emptyScrolls++;
        log(`Scroll ${scrollCount}: no new ads (${emptyScrolls} empty scrolls, stops after ${maxEmptyScrolls})`);
      }

      if (onProgress) {
        onProgress({ type: "progress", current: allAds.length, max: maxAds });
      }

      // Delay between scrolls
      await randomDelay(2000, 4000);
    }

    // Enrich ads that have empty media with images/videos from the rendered DOM.
    // GraphQL often omits snapshot data for logged-out sessions (gatedType: "LOGGED_OUT")
    // but the page still renders ad images visually.
    const adsNeedingMedia = allAds.filter(
      (ad) => ad.images.length === 0 && ad.videos.length === 0
    );
    if (adsNeedingMedia.length > 0) {
      log(`${adsNeedingMedia.length}/${allAds.length} ads have no media from GraphQL, extracting from DOM...`);
      try {
        const domMedia = await extractMediaFromDOM(page);
        let enriched = 0;
        for (const ad of adsNeedingMedia) {
          const media = domMedia[ad.libraryId];
          if (media) {
            if (media.images.length > 0) ad.images = media.images;
            if (media.videos.length > 0) ad.videos = media.videos;
            enriched++;
          }
        }
        if (enriched > 0) {
          log(`Enriched ${enriched} ads with media from DOM`);
        } else {
          log("No matching media found in DOM for these ads");
        }
      } catch (err) {
        log(`DOM media extraction failed: ${err.message}`);
      }
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const results = allAds.slice(0, maxAds);

  // Download media if requested
  if (downloadMedia && results.length > 0) {
    await downloadAdMedia(results, outputDir, log);
  }

  log(`Scraping complete. Total ads: ${results.length}`);

  return {
    meta: {
      query,
      country,
      activeStatus,
      adType,
      mediaType,
      sortBy,
      totalResults: results.length,
      scrapedAt: new Date().toISOString(),
      url,
      mode: "graphql",
      resumedFrom: previouslySeenIds.length || null,
    },
    data: results,
  };
}

async function downloadAdMedia(ads, outputDir, log) {
  const mediaDir = path.join(outputDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });

  let downloaded = 0;
  let skipped = 0;
  for (const ad of ads) {
    const adDir = path.join(mediaDir, ad.libraryId);

    // Skip if already downloaded
    if (fs.existsSync(adDir) && fs.readdirSync(adDir).length > 0) {
      skipped++;
      continue;
    }

    const imageUrls = (ad.images || []).map((img) => img.src).filter(Boolean);
    if (imageUrls.length > 0) {
      fs.mkdirSync(adDir, { recursive: true });
    }

    for (let i = 0; i < imageUrls.length; i++) {
      try {
        const ext = getExtFromUrl(imageUrls[i]) || "jpg";
        const filename = `image_${i}.${ext}`;
        const resp = await fetch(imageUrls[i]);
        if (resp.ok) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          fs.writeFileSync(path.join(adDir, filename), buffer);
          downloaded++;
        }
      } catch {}
      await randomDelay(200, 500);
    }

    const videoUrls = (ad.videos || []).map((vid) => vid.src).filter(Boolean);
    if (videoUrls.length > 0) {
      fs.mkdirSync(adDir, { recursive: true });
    }

    for (let i = 0; i < videoUrls.length; i++) {
      try {
        const ext = getExtFromUrl(videoUrls[i]) || "mp4";
        const filename = `video_${i}.${ext}`;
        const resp = await fetch(videoUrls[i]);
        if (resp.ok) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          fs.writeFileSync(path.join(adDir, filename), buffer);
          downloaded++;
        }
      } catch {}
      await randomDelay(200, 500);
    }
  }

  log(`Downloaded ${downloaded} media files to ${mediaDir}${skipped > 0 ? ` (${skipped} ads skipped, already downloaded)` : ""}`);
}

function sanitizeFolderName(name) {
  return (name || "unknown")
    .replace(/[^a-zA-Z0-9\-_ ]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .substring(0, 50)
    .replace(/_$/, "");
}

async function saveAdToFolder(ad, baseDir) {
  const folderName = ad.libraryId;
  const adDir = path.join(baseDir, folderName);

  // Skip if already downloaded
  if (fs.existsSync(path.join(adDir, "ad.json"))) {
    return { mediaFiles: 0, bytes: 0, skipped: true };
  }

  fs.mkdirSync(adDir, { recursive: true });

  let mediaFiles = 0;
  let bytes = 0;

  const jsonContent = JSON.stringify(ad, null, 2);
  fs.writeFileSync(path.join(adDir, "ad.json"), jsonContent);
  bytes += Buffer.byteLength(jsonContent);

  const textParts = [];
  textParts.push(`Library ID: ${ad.libraryId}`);
  textParts.push(`Status: ${ad.status}`);
  if (ad.advertiserName) textParts.push(`Advertiser: ${ad.advertiserName}`);
  if (ad.startDate) textParts.push(`Started: ${ad.startDate}`);
  if (ad.endDate) textParts.push(`Ended: ${ad.endDate}`);
  if (ad.platforms?.length) textParts.push(`Platforms: ${ad.platforms.join(", ")}`);
  textParts.push("");
  if (ad.gqlTitle) textParts.push(`--- TITLE ---\n${ad.gqlTitle}\n`);
  if (ad.adBody) textParts.push(`--- AD COPY ---\n${ad.adBody}\n`);
  if (ad.caption) textParts.push(`--- CAPTION ---\n${ad.caption}\n`);
  if (ad.ctaText) textParts.push(`CTA: ${ad.ctaText}`);
  if (ad.ctaUrl) textParts.push(`Landing Page: ${ad.ctaUrl}`);
  if (ad.advertiserUrl) textParts.push(`Advertiser URL: ${ad.advertiserUrl}`);

  const textContent = textParts.join("\n");
  fs.writeFileSync(path.join(adDir, "ad-copy.txt"), textContent);
  bytes += Buffer.byteLength(textContent);

  for (let i = 0; i < (ad.images || []).length; i++) {
    const img = ad.images[i];
    if (!img.src) continue;
    try {
      const ext = getExtFromUrl(img.src) || "jpg";
      const resp = await fetch(img.src);
      if (resp.ok) {
        const buffer = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(path.join(adDir, `image_${i}.${ext}`), buffer);
        mediaFiles++;
        bytes += buffer.length;
      }
    } catch {}
    await randomDelay(200, 500);
  }

  for (let i = 0; i < (ad.videos || []).length; i++) {
    const vid = ad.videos[i];
    if (!vid.src) continue;
    try {
      const ext = getExtFromUrl(vid.src) || "mp4";
      const resp = await fetch(vid.src);
      if (resp.ok) {
        const buffer = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(path.join(adDir, `video_${i}.${ext}`), buffer);
        mediaFiles++;
        bytes += buffer.length;
      }
    } catch {}
    await randomDelay(200, 500);
    if (vid.poster) {
      try {
        const resp = await fetch(vid.poster);
        if (resp.ok) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          fs.writeFileSync(path.join(adDir, `video_${i}_thumb.jpg`), buffer);
          bytes += buffer.length;
        }
      } catch {}
      await randomDelay(200, 500);
    }
  }

  return { mediaFiles, bytes };
}

async function saveAllAds(ads, outputDir, onProgress) {
  const adsDir = path.join(outputDir, "ads");
  fs.mkdirSync(adsDir, { recursive: true });

  let totalMedia = 0;
  let totalBytes = 0;

  // Group ads by advertiser for organized folder structure
  const byAdvertiser = {};
  for (const ad of ads) {
    const advName = sanitizeFolderName(ad.advertiserName || "unknown");
    if (!byAdvertiser[advName]) byAdvertiser[advName] = [];
    byAdvertiser[advName].push(ad);
  }

  let processed = 0;
  let skipped = 0;
  for (const [advName, advAds] of Object.entries(byAdvertiser)) {
    const advDir = path.join(adsDir, advName);
    fs.mkdirSync(advDir, { recursive: true });

    for (const ad of advAds) {
      try {
        const stats = await saveAdToFolder(ad, advDir);
        if (stats.skipped) {
          skipped++;
        } else {
          totalMedia += stats.mediaFiles;
          totalBytes += stats.bytes;
        }
      } catch {}

      processed++;
      if (onProgress) {
        onProgress({
          type: "download_progress",
          current: processed,
          total: ads.length,
          mediaFiles: totalMedia,
          bytes: totalBytes,
          skipped,
        });
      }
    }
  }

  // Merge with existing summary if present (resume mode)
  let mergedAds = ads;
  const summaryPath = path.join(adsDir, "_summary.json");
  try {
    if (fs.existsSync(summaryPath)) {
      const existing = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
      if (existing.ads && Array.isArray(existing.ads)) {
        const adsById = new Map();
        for (const ad of existing.ads) adsById.set(ad.libraryId, ad);
        for (const ad of ads) adsById.set(ad.libraryId, ad); // new ads overwrite
        mergedAds = [...adsById.values()];
      }
    }
  } catch {}

  // Recount advertisers from merged set
  const mergedByAdvertiser = {};
  for (const ad of mergedAds) {
    const advName = sanitizeFolderName(ad.advertiserName || "unknown");
    if (!mergedByAdvertiser[advName]) mergedByAdvertiser[advName] = [];
    mergedByAdvertiser[advName].push(ad);
  }

  const summaryJson = JSON.stringify({
    totalAds: mergedAds.length,
    totalMedia,
    totalBytes,
    advertisers: Object.keys(mergedByAdvertiser).length,
    ads: mergedAds,
  }, null, 2);
  fs.writeFileSync(summaryPath, summaryJson);
  fs.writeFileSync(path.join(adsDir, "_summary.csv"), convertToCSV(mergedAds));

  return {
    totalAds: mergedAds.length,
    totalMedia,
    totalBytes,
    skipped,
    advertisers: Object.keys(mergedByAdvertiser).length,
    newAds: ads.length,
  };
}

module.exports = {
  scrapeAdsGraphQL,
  saveAllAds,
  normalizeAd,
};
