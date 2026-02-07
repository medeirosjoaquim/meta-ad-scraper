const fs = require("fs");
const path = require("path");

const DOWNLOADS_DIR = path.join(__dirname, "downloads");

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "avi", "mkv", "m4v"]);

function scanDownloads() {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    console.log("No downloads/ directory found.");
    process.exit(0);
  }

  const entries = fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true });
  const folders = entries.filter(e => e.isDirectory() && e.name !== ".state");

  if (folders.length === 0) {
    console.log("No download folders found.");
    process.exit(0);
  }

  let grandTotalAds = 0;
  let grandTotalImages = 0;
  let grandTotalVideos = 0;
  const globalCompanies = {};

  for (const folder of folders) {
    const adsDir = path.join(DOWNLOADS_DIR, folder.name, "ads");
    if (!fs.existsSync(adsDir)) continue;

    const advertisers = fs.readdirSync(adsDir, { withFileTypes: true }).filter(e => e.isDirectory());

    for (const adv of advertisers) {
      const advPath = path.join(adsDir, adv.name);
      const adFolders = fs.readdirSync(advPath, { withFileTypes: true }).filter(e => e.isDirectory());

      if (adFolders.length === 0) continue;

      if (!globalCompanies[adv.name]) {
        globalCompanies[adv.name] = { ads: 0, images: 0, videos: 0 };
      }

      for (const adFolder of adFolders) {
        const adPath = path.join(advPath, adFolder.name);
        if (!fs.existsSync(path.join(adPath, "ad.json"))) continue;

        globalCompanies[adv.name].ads++;
        grandTotalAds++;

        const files = fs.readdirSync(adPath);
        for (const file of files) {
          const ext = path.extname(file).slice(1).toLowerCase();
          if (IMAGE_EXTS.has(ext)) {
            // Skip video thumbnails (video_N_thumb.jpg)
            if (file.includes("_thumb.")) continue;
            globalCompanies[adv.name].images++;
            grandTotalImages++;
          } else if (VIDEO_EXTS.has(ext)) {
            globalCompanies[adv.name].videos++;
            grandTotalVideos++;
          }
        }
      }
    }
  }

  const companyCount = Object.keys(globalCompanies).length;
  const grandTotalMedia = grandTotalImages + grandTotalVideos;

  // Sort companies by ad count descending
  const sorted = Object.entries(globalCompanies)
    .sort((a, b) => b[1].ads - a[1].ads);

  // Print report
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  META ADS SCRAPER — DOWNLOAD SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
  console.log(`  Companies:    ${companyCount}`);
  console.log(`  Total Ads:    ${grandTotalAds}`);
  console.log(`  Total Media:  ${grandTotalMedia}  (${grandTotalImages} images, ${grandTotalVideos} videos)`);
  console.log("");
  console.log("───────────────────────────────────────────────────────────────");
  console.log(`  ${"Company".padEnd(40)} ${"Ads".padStart(6)} ${"Imgs".padStart(6)} ${"Vids".padStart(6)}`);
  console.log("───────────────────────────────────────────────────────────────");

  for (const [name, stats] of sorted) {
    const display = name.replace(/_/g, " ");
    const truncated = display.length > 38 ? display.substring(0, 35) + "..." : display;
    console.log(`  ${truncated.padEnd(40)} ${String(stats.ads).padStart(6)} ${String(stats.images).padStart(6)} ${String(stats.videos).padStart(6)}`);
  }

  console.log("───────────────────────────────────────────────────────────────");
  console.log(`  ${"TOTAL".padEnd(40)} ${String(grandTotalAds).padStart(6)} ${String(grandTotalImages).padStart(6)} ${String(grandTotalVideos).padStart(6)}`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
}

scanDownloads();
