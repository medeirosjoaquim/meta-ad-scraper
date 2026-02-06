const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const AD_LIBRARY_BASE = "https://www.facebook.com/ads/library/";

const COUNTRY_CODES = {
  US: "United States",
  BR: "Brazil",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  DE: "Germany",
  FR: "France",
  IT: "Italy",
  ES: "Spain",
  IN: "India",
  MX: "Mexico",
  JP: "Japan",
  AR: "Argentina",
  CO: "Colombia",
  CL: "Chile",
  PT: "Portugal",
  NL: "Netherlands",
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  FI: "Finland",
  PL: "Poland",
  IE: "Ireland",
  NZ: "New Zealand",
  ZA: "South Africa",
  NG: "Nigeria",
  KE: "Kenya",
  EG: "Egypt",
  SA: "Saudi Arabia",
  AE: "United Arab Emirates",
  IL: "Israel",
  TR: "Turkey",
  KR: "South Korea",
  TW: "Taiwan",
  PH: "Philippines",
  TH: "Thailand",
  VN: "Vietnam",
  ID: "Indonesia",
  MY: "Malaysia",
  SG: "Singapore",
  ALL: "All",
};

function buildSearchUrl(params) {
  const url = new URL(AD_LIBRARY_BASE);

  url.searchParams.set("active_status", params.activeStatus || "active");
  url.searchParams.set("ad_type", params.adType || "all");
  url.searchParams.set("country", params.country || "US");
  url.searchParams.set("is_targeted_country", "false");
  url.searchParams.set("media_type", params.mediaType || "all");
  url.searchParams.set("q", params.query);
  url.searchParams.set("search_type", params.searchType || "keyword_unordered");

  if (params.sortBy === "newest") {
    url.searchParams.set("sort_data[direction]", "desc");
    url.searchParams.set("sort_data[mode]", "relevancy_monthly_grouped");
  } else if (params.sortBy === "impressions") {
    url.searchParams.set("sort_data[direction]", "desc");
    url.searchParams.set("sort_data[mode]", "total_impressions");
  }

  return url.toString();
}

function randomDelay(min = 800, max = 2000) {
  return new Promise((resolve) =>
    setTimeout(resolve, min + Math.random() * (max - min))
  );
}

async function scrapeAds(params, onProgress, { signal } = {}) {
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
  } = params;

  function checkAborted() {
    if (signal && signal.aborted) {
      const err = new Error("Scrape cancelled");
      err.name = "AbortError";
      throw err;
    }
  }

  const log = (msg) => {
    console.log(`[scraper] ${msg}`);
    if (onProgress) onProgress({ type: "log", message: msg });
  };

  const url = buildSearchUrl({
    query,
    country,
    activeStatus,
    adType,
    mediaType,
    sortBy,
  });

  log(`Navigating to: ${url}`);

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

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });

  const page = await context.newPage();

  // Collect GraphQL ad data from intercepted responses
  const graphqlAds = new Map();

  // Listen for GraphQL responses via CDP to avoid blocking requests
  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!url.includes("/api/graphql")) return;
      const contentType = response.headers()["content-type"] || "";
      if (!contentType.includes("json") && !contentType.includes("text")) return;

      const body = await response.text().catch(() => "");
      if (!body) return;

      const lines = body.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          extractAdsFromGraphQL(json, graphqlAds, log);
        } catch {
          // not valid JSON line
        }
      }
    } catch {
      // response parsing is best-effort
    }
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Close any cookie/consent dialogs
    await dismissDialogs(page);

    log("Page loaded, starting extraction...");

    const allAds = [];
    const seenIds = new Set();
    let emptyScrolls = 0;
    const maxEmptyScrolls = 5;

    while (allAds.length < maxAds && emptyScrolls < maxEmptyScrolls) {
      checkAborted();
      // Extract ads from current page DOM
      const pageAds = await extractAdsFromDOM(page);

      let newCount = 0;
      for (const ad of pageAds) {
        if (!seenIds.has(ad.libraryId)) {
          seenIds.add(ad.libraryId);
          // Merge with GraphQL data if available
          const gqlData = graphqlAds.get(ad.libraryId);
          if (gqlData) {
            Object.assign(ad, gqlData);
          }
          allAds.push(ad);
          newCount++;
        }
      }

      log(
        `Extracted ${newCount} new ads (total: ${allAds.length}/${maxAds})`
      );
      if (onProgress)
        onProgress({
          type: "progress",
          current: allAds.length,
          max: maxAds,
        });

      if (allAds.length >= maxAds) break;

      if (newCount === 0) {
        emptyScrolls++;
      } else {
        emptyScrolls = 0;
      }

      // Try clicking "See more" button first
      const loadedMore = await clickSeeMore(page);
      if (!loadedMore) {
        // Fallback to scrolling
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await randomDelay(1500, 3000);

        // Check if we've reached the end
        const atBottom = await page.evaluate(() => {
          return (
            window.innerHeight + window.scrollY >=
            document.body.scrollHeight - 200
          );
        });

        if (atBottom && newCount === 0) {
          emptyScrolls++;
        }
      } else {
        await randomDelay(2000, 4000);
      }
    }

    // Also merge any remaining GraphQL data
    for (const ad of allAds) {
      const gqlData = graphqlAds.get(ad.libraryId);
      if (gqlData) {
        for (const [key, val] of Object.entries(gqlData)) {
          if (val && !ad[key]) ad[key] = val;
        }
      }
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
      },
      data: results,
    };
  } finally {
    await browser.close();
  }
}

async function dismissDialogs(page) {
  try {
    // Try common cookie consent / dialog close patterns
    const selectors = [
      '[data-testid="cookie-policy-manage-dialog-accept-button"]',
      'button[title="Allow all cookies"]',
      'button[title="Accept All"]',
      'div[role="dialog"] button[type="submit"]',
    ];
    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    }
  } catch {
    // dialogs are optional
  }
}

async function extractAdsFromDOM(page) {
  return page.evaluate(() => {
    const ads = [];

    // Strategy: Find all spans containing "Library ID:", then find
    // their nearest common ancestor — that's the list container
    const idSpans = [];
    const allSpans = document.querySelectorAll("span");
    for (const span of allSpans) {
      if (span.textContent.includes("Library ID:")) idSpans.push(span);
    }
    if (idSpans.length < 2) return ads;

    function getAncestors(el) {
      const path = [];
      while (el && el !== document.body) {
        path.push(el);
        el = el.parentElement;
      }
      return path;
    }

    const path1 = new Set(getAncestors(idSpans[0]));
    let listContainer = null;
    for (const el of getAncestors(idSpans[1])) {
      if (path1.has(el)) {
        listContainer = el;
        break;
      }
    }

    if (!listContainer) return ads;

    // Each direct child DIV that contains "Library ID:" is an ad card
    const children = Array.from(listContainer.children);
    for (const child of children) {
      if (child.tagName === "HR") continue;
      const fullText = child.innerText || "";
      if (!fullText.includes("Library ID:")) continue;

      try {
        // Extract Library ID
        const idMatch = fullText.match(/Library ID:\s*(\d+)/);
        if (!idMatch) continue;
        const libraryId = idMatch[1];

        // Extract status (Active/Inactive/Ativo/Inativo)
        const statusMatch = fullText.match(
          /^[\s\u200B]*(Active|Inactive|Ativo|Inativo)/
        );
        const status = statusMatch
          ? statusMatch[1].replace("Ativo", "Active").replace("Inativo", "Inactive")
          : "Unknown";

        // Extract start date (English and Portuguese)
        const dateMatch = fullText.match(
          /(?:Started running on|Veiculação iniciada em)\s+(.+?)(?:\s+Platform|\s+Plataforma|\s*$)/m
        );
        const startDate = dateMatch ? dateMatch[1].trim() : null;

        // Extract advertiser name from link
        let advertiserName = null;
        let advertiserUrl = null;
        const advertiserLinks = child.querySelectorAll(
          'a[href*="facebook.com/"]'
        );
        for (const link of advertiserLinks) {
          const href = link.getAttribute("href") || "";
          const text = link.textContent.trim();
          if (
            href &&
            !href.includes("/ads/library") &&
            !href.includes("/help") &&
            !href.includes("/policies") &&
            !href.includes("/privacy") &&
            !href.includes("/language") &&
            text.length > 0 &&
            text.length < 100
          ) {
            advertiserName = text;
            advertiserUrl = href;
            break;
          }
        }

        // Extract co-advertiser (e.g. "X with Y" pattern)
        let coAdvertiser = null;
        const allPageLinks = child.querySelectorAll('a[href*="facebook.com/"]');
        const pageLinks = [];
        for (const link of allPageLinks) {
          const href = link.getAttribute("href") || "";
          const text = link.textContent.trim();
          if (
            href &&
            !href.includes("/ads/library") &&
            !href.includes("/help") &&
            !href.includes("/policies") &&
            text.length > 0 &&
            text.length < 100
          ) {
            pageLinks.push({ name: text, url: href });
          }
        }
        if (pageLinks.length > 1) {
          coAdvertiser = pageLinks[1];
        }

        // Extract ad body text from buttons (expandable text)
        let adBody = null;
        const textButtons = child.querySelectorAll('button, [role="button"]');
        for (const btn of textButtons) {
          const btnText = btn.textContent.trim();
          if (
            btnText.length > 50 &&
            !btnText.match(
              /^(See |Ver |Open |Play |Abrir|Reproduzir|Entrar|Reativar|Configurações|Settings)/i
            )
          ) {
            adBody = btnText;
            break;
          }
        }

        // Extract number of ads using this creative
        const adsCountMatch = fullText.match(
          /(\d+)\s+(?:ads?|anúncios?)\s+(?:use|usam)/
        );
        const creativeCount = adsCountMatch
          ? parseInt(adsCountMatch[1])
          : 1;

        // Check if ad has multiple versions
        const hasMultipleVersions =
          fullText.includes("multiple versions") ||
          fullText.includes("várias versões");

        // Extract CTA link
        let ctaUrl = null;
        let ctaText = null;
        const ctaLinks = child.querySelectorAll(
          'a[href*="l.facebook.com/l.php"]'
        );
        for (const link of ctaLinks) {
          const href = link.getAttribute("href") || "";
          const urlMatch = href.match(/[?&]u=([^&]+)/);
          if (urlMatch) {
            ctaUrl = decodeURIComponent(urlMatch[1]);
          }
          const ctaBtns = link.querySelectorAll("button");
          const ctaTexts = [];
          for (const btn of ctaBtns) {
            const t = btn.textContent.trim();
            if (t && t.length < 50) ctaTexts.push(t);
          }
          if (ctaTexts.length > 0) {
            ctaText = ctaTexts[ctaTexts.length - 1];
          }
          break;
        }

        // Extract images
        const images = [];
        const imgElements = child.querySelectorAll("img");
        for (const img of imgElements) {
          const src = img.getAttribute("src") || "";
          if (
            src &&
            !src.includes("emoji") &&
            !src.includes("rsrc.php") &&
            img.width > 50
          ) {
            images.push({
              src,
              alt: img.getAttribute("alt") || "",
              width: img.naturalWidth || img.width,
              height: img.naturalHeight || img.height,
            });
          }
        }

        // Extract videos
        const videos = [];
        const videoElements = child.querySelectorAll("video");
        for (const video of videoElements) {
          const src =
            video.getAttribute("src") ||
            video.querySelector("source")?.getAttribute("src") ||
            "";
          if (src) {
            videos.push({
              src,
              poster: video.getAttribute("poster") || "",
            });
          }
        }

        // Check for age-gated content
        const isAgeGated =
          fullText.includes("confirm your age") ||
          fullText.includes("confirmar sua idade");

        ads.push({
          libraryId,
          status,
          startDate,
          advertiserName,
          advertiserUrl,
          coAdvertiser,
          adBody,
          ctaUrl,
          ctaText,
          creativeCount,
          hasMultipleVersions,
          isAgeGated,
          images: images.filter((img) => img.src),
          videos: videos.filter((vid) => vid.src),
        });
      } catch {
        // skip malformed ad cards
      }
    }

    return ads;
  });
}

function extractAdsFromGraphQL(json, adsMap, log) {
  try {
    // Navigate through various possible response structures
    const searchPaths = [
      ["data", "ad_library_main", "search_results_connection"],
      ["data", "ad_library_search"],
      ["data", "adLibrarySearch"],
    ];

    let results = null;
    for (const pathArr of searchPaths) {
      let current = json;
      for (const key of pathArr) {
        if (current && typeof current === "object" && key in current) {
          current = current[key];
        } else {
          current = null;
          break;
        }
      }
      if (current) {
        results = current;
        break;
      }
    }

    if (!results) {
      // Deep search for edges array
      const found = deepFindKey(json, "edges");
      if (found && Array.isArray(found)) {
        results = { edges: found };
      }
    }

    if (!results) return;

    const edges = results.edges || results.results || [];
    if (!Array.isArray(edges)) return;

    let count = 0;
    for (const edge of edges) {
      const node = edge.node || edge;
      if (!node) continue;

      const adId =
        node.adArchiveID ||
        node.ad_archive_id ||
        node.adId ||
        node.collation_id;
      if (!adId) continue;

      const adData = {
        libraryId: String(adId),
        gqlPageName:
          node.page_name ||
          node.pageName ||
          node.snapshot?.page_name,
        gqlPageId:
          node.page_id || node.pageId || node.snapshot?.page_id,
        gqlAdBody:
          node.snapshot?.body?.text ||
          node.snapshot?.cards?.[0]?.body ||
          node.ad_creative_bodies?.[0],
        gqlTitle:
          node.snapshot?.title ||
          node.snapshot?.cards?.[0]?.title ||
          node.ad_creative_link_titles?.[0],
        gqlCtaText:
          node.snapshot?.cta_text ||
          node.snapshot?.cards?.[0]?.cta_text,
        gqlCtaUrl:
          node.snapshot?.link_url ||
          node.snapshot?.cards?.[0]?.link_url,
        gqlStartDate: node.start_date || node.startDate,
        gqlEndDate: node.end_date || node.endDate,
        gqlIsActive: node.is_active ?? node.isActive,
        gqlPublisherPlatforms:
          node.publisher_platforms || node.publisherPlatforms,
        gqlSpend: node.spend,
        gqlImpressions: node.impressions,
        gqlReach: node.reach,
        gqlDemographics: node.demographic_distribution,
        gqlCurrency: node.currency,
        gqlImageUrl:
          node.snapshot?.images?.[0]?.original_image_url ||
          node.snapshot?.cards?.[0]?.original_image_url,
        gqlVideoUrl:
          node.snapshot?.videos?.[0]?.video_sd_url ||
          node.snapshot?.videos?.[0]?.video_hd_url,
        gqlVideoPreviewUrl:
          node.snapshot?.videos?.[0]?.video_preview_image_url,
      };

      adsMap.set(adData.libraryId, adData);
      count++;
    }

    if (count > 0) {
      log(`GraphQL: intercepted ${count} ads`);
    }
  } catch {
    // GraphQL parsing is best-effort
  }
}

function deepFindKey(obj, targetKey, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== "object") return null;
  if (targetKey in obj) return obj[targetKey];
  for (const key of Object.keys(obj)) {
    const result = deepFindKey(obj[key], targetKey, depth + 1);
    if (result) return result;
  }
  return null;
}

async function clickSeeMore(page) {
  try {
    // Try English and Portuguese variants
    const selectors = [
      'a:has-text("See more")',
      'a:has-text("Ver mais")',
      'button:has-text("See more")',
      'button:has-text("Ver mais")',
    ];

    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.scrollIntoViewIfNeeded();
        await randomDelay(500, 1000);
        await btn.click({ timeout: 5000 });
        await page.waitForTimeout(2000);
        return true;
      }
    }
  } catch {
    // "See more" not found or click failed
  }
  return false;
}

async function downloadAdMedia(ads, outputDir, log) {
  const mediaDir = path.join(outputDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });

  let downloaded = 0;
  for (const ad of ads) {
    const adDir = path.join(mediaDir, ad.libraryId);

    // Download images
    const imageUrls = [
      ...(ad.images || []).map((img) => img.src),
      ad.gqlImageUrl,
    ].filter(Boolean);

    if (imageUrls.length > 0) {
      fs.mkdirSync(adDir, { recursive: true });
    }

    for (let i = 0; i < imageUrls.length; i++) {
      try {
        const imgUrl = imageUrls[i];
        const ext = getExtFromUrl(imgUrl) || "jpg";
        const filename = `image_${i}.${ext}`;
        const resp = await fetch(imgUrl);
        if (resp.ok) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          fs.writeFileSync(path.join(adDir, filename), buffer);
          downloaded++;
        }
      } catch {
        // skip failed downloads
      }
    }

    // Download videos
    const videoUrls = [
      ...(ad.videos || []).map((vid) => vid.src),
      ad.gqlVideoUrl,
    ].filter(Boolean);

    if (videoUrls.length > 0) {
      fs.mkdirSync(adDir, { recursive: true });
    }

    for (let i = 0; i < videoUrls.length; i++) {
      try {
        const vidUrl = videoUrls[i];
        const ext = getExtFromUrl(vidUrl) || "mp4";
        const filename = `video_${i}.${ext}`;
        const resp = await fetch(vidUrl);
        if (resp.ok) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          fs.writeFileSync(path.join(adDir, filename), buffer);
          downloaded++;
        }
      } catch {
        // skip failed downloads
      }
    }
  }

  log(`Downloaded ${downloaded} media files to ${mediaDir}`);
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

function convertToCSV(ads) {
  const headers = [
    "libraryId",
    "status",
    "advertiserName",
    "advertiserUrl",
    "startDate",
    "adBody",
    "ctaUrl",
    "ctaText",
    "creativeCount",
    "hasMultipleVersions",
    "isAgeGated",
    "imageCount",
    "videoCount",
    "gqlPageId",
    "gqlSpend",
    "gqlImpressions",
    "gqlPlatforms",
  ];

  const escape = (val) => {
    if (val == null) return "";
    const str = String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = ads.map((ad) =>
    [
      ad.libraryId,
      ad.status,
      ad.advertiserName || ad.gqlPageName,
      ad.advertiserUrl,
      ad.startDate || ad.gqlStartDate,
      ad.adBody || ad.gqlAdBody,
      ad.ctaUrl || ad.gqlCtaUrl,
      ad.ctaText || ad.gqlCtaText,
      ad.creativeCount,
      ad.hasMultipleVersions,
      ad.isAgeGated,
      (ad.images || []).length,
      (ad.videos || []).length,
      ad.gqlPageId,
      ad.gqlSpend ? JSON.stringify(ad.gqlSpend) : "",
      ad.gqlImpressions ? JSON.stringify(ad.gqlImpressions) : "",
      ad.gqlPublisherPlatforms
        ? JSON.stringify(ad.gqlPublisherPlatforms)
        : "",
    ]
      .map(escape)
      .join(",")
  );

  return [headers.join(","), ...rows].join("\n");
}

module.exports = {
  scrapeAds,
  buildSearchUrl,
  convertToCSV,
  COUNTRY_CODES,
};
