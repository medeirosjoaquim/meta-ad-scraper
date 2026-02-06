// meta.js - Meta Ads Library API Test Script
// Usage: node index.js

require("dotenv").config();

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION = "v24.0";
const BASE_URL = `https://graph.facebook.com/${API_VERSION}/ads_archive`;

async function searchAds({ searchTerms, limit = 5 }) {
  const params = new URLSearchParams({
    search_terms: searchTerms,
    ad_reached_countries: "['US']",
    ad_type: "POLITICAL_AND_ISSUE_ADS",
    ad_active_status: "ALL",
    fields: [
      "id",
      "page_name",
      "page_id",
      "ad_creation_time",
      "ad_delivery_start_time",
      "ad_delivery_stop_time",
      "ad_creative_bodies",
      "ad_creative_link_titles",
      "ad_snapshot_url",
      "publisher_platforms",
      "bylines",
      "currency",
      "spend",
      "impressions",
      "demographic_distribution",
      "delivery_by_region",
    ].join(","),
    limit: limit.toString(),
    access_token: ACCESS_TOKEN,
  });

  const url = `${BASE_URL}?${params}`;
  console.log(`\n🔍 Searching for: "${searchTerms}" (limit: ${limit})\n`);

  const response = await fetch(url);
  const data = await response.json();

  if (data.error) {
    console.error("❌ API Error:", data.error.message);
    console.error("   Code:", data.error.code);
    console.error("   Type:", data.error.type);
    return null;
  }

  return data;
}

function formatAd(ad, index) {
  const status = ad.ad_delivery_stop_time ? "INACTIVE" : "ACTIVE";
  const spend = ad.spend
    ? `$${ad.spend.lower_bound} - $${ad.spend.upper_bound}`
    : "N/A";
  const impressions = ad.impressions
    ? `${ad.impressions.lower_bound} - ${ad.impressions.upper_bound}`
    : "N/A";
  const body = ad.ad_creative_bodies?.[0]?.substring(0, 120) || "N/A";

  return `
  ─── Ad #${index + 1} ───────────────────────────────
  ID:          ${ad.id}
  Page:        ${ad.page_name}
  Status:      ${status}
  Started:     ${ad.ad_delivery_start_time || "N/A"}
  Stopped:     ${ad.ad_delivery_stop_time || "Still running"}
  Platforms:   ${ad.publisher_platforms?.join(", ") || "N/A"}
  Funded by:   ${ad.bylines || "N/A"}
  Spend:       ${spend}
  Impressions: ${impressions}
  Body:        ${body}${body.length >= 120 ? "..." : ""}
  Snapshot:    ${ad.ad_snapshot_url || "N/A"}`;
}

async function main() {
  if (!ACCESS_TOKEN) {
    console.error("❌ Missing META_ACCESS_TOKEN in .env file");
    process.exit(1);
  }

  console.log("=== Meta Ads Library API Test ===");
  console.log(`API Version: ${API_VERSION}`);

  // Test 1: Basic search
  const results = await searchAds({ searchTerms: "climate", limit: 5 });

  if (!results) {
    process.exit(1);
  }

  const ads = results.data || [];
  console.log(`✅ Found ${ads.length} ads\n`);

  ads.forEach((ad, i) => console.log(formatAd(ad, i)));

  // Pagination info
  if (results.paging?.next) {
    console.log("\n📄 More results available (pagination cursor present)");
  }

  // Summary
  console.log("\n=== Summary ===");
  const uniquePages = [...new Set(ads.map((a) => a.page_name))];
  console.log(`Total ads returned: ${ads.length}`);
  console.log(`Unique advertisers: ${uniquePages.length}`);
  console.log(`Advertisers: ${uniquePages.join(", ")}`);
}

main().catch(console.error);
