require("dotenv").config();
const express = require("express");
const { scrapeAds, convertToCSV, COUNTRY_CODES } = require("./scraper");
const { scrapeAdsGraphQL, saveAllAds } = require("./graphql-scraper");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 7676;

// Track active scrape jobs
const scrapeJobs = new Map();
const MAX_CONCURRENT_JOBS = 2;

app.use(express.json());
app.use(express.static("public"));

// ─── Routes ─────────────────────────────────────────────

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/scrape/countries", (req, res) => {
  res.json(COUNTRY_CODES);
});

app.post("/scrape", async (req, res) => {
  const {
    query,
    country = "US",
    activeStatus = "active",
    adType = "all",
    mediaType = "all",
    sortBy = "impressions",
    maxAds = 50,
    downloadMedia = false,
    downloadAll = false,
    mode = "graphql",
  } = req.body;

  if (!query) {
    return res.status(400).json({ error: "Missing required parameter: query" });
  }

  // Enforce concurrent job limit to avoid rate limiting
  const activeJobCount = [...scrapeJobs.values()].filter(
    (j) => j.status === "running" || j.status === "downloading"
  ).length;
  if (activeJobCount >= MAX_CONCURRENT_JOBS) {
    return res.status(429).json({
      error: `Too many concurrent scraping jobs (max ${MAX_CONCURRENT_JOBS}). Wait for a running job to finish.`,
    });
  }

  const clampedMax = Math.min(Math.max(parseInt(maxAds) || 50, 1), 1000);

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Use downloads/ for bulk download, output/ for regular scrapes
  let outputDir;
  if (downloadAll) {
    const safeQuery = query.replace(/[^a-zA-Z0-9\-_ ]/g, "").replace(/\s+/g, "_").substring(0, 40);
    const dateStr = new Date().toISOString().slice(0, 10);
    const folderName = `${safeQuery}_${dateStr}_${jobId}`;
    outputDir = path.join(process.cwd(), "downloads", folderName);
  } else {
    outputDir = path.join(process.cwd(), "output", jobId);
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const job = {
    id: jobId,
    status: "running",
    phase: "scraping",
    mode,
    downloadAll,
    outputDir,
    progress: { current: 0, max: clampedMax },
    downloadProgress: null,
    downloadStats: null,
    phaseDetail: null,
    logs: [],
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
    abortController: new AbortController(),
  };
  scrapeJobs.set(jobId, job);

  // Return job ID immediately so client can poll
  res.json({ jobId, status: "started", mode, downloadAll });

  const scraperParams = { query, country, activeStatus, adType, mediaType, sortBy, maxAds: clampedMax, downloadMedia, outputDir };
  const onEvent = (event) => {
    if (event.type === "log") {
      job.logs.push(event.message);
      const msg = event.message.toLowerCase();
      if (msg.includes("launching browser")) job.phaseDetail = "Launching browser...";
      else if (msg.includes("navigating")) job.phaseDetail = "Navigating to page...";
      else if (msg.includes("ad content detected")) job.phaseDetail = "Loading initial ads...";
      else if (msg.includes("scroll ")) job.phaseDetail = "Scrolling for more ads...";
      else if (msg.includes("rate limit")) job.phaseDetail = "Rate limited, waiting...";
      else if (msg.includes("dom extraction") || msg.includes("dom fallback")) job.phaseDetail = "Extracting from page...";
      else if (msg.includes("scraping complete")) job.phaseDetail = "Finishing up...";
      else if (msg.includes("starting media download")) job.phaseDetail = "Saving media files...";
    } else if (event.type === "progress") {
      job.progress = { current: event.current, max: event.max };
    }
  };

  // Choose scraper based on mode
  const scraperFn = mode === "playwright" ? scrapeAds : scrapeAdsGraphQL;

  try {
    const result = await scraperFn(scraperParams, onEvent, { signal: job.abortController.signal });
    job.result = result;

    // Save results to disk
    fs.writeFileSync(
      path.join(outputDir, "results.json"),
      JSON.stringify(result, null, 2)
    );
    fs.writeFileSync(
      path.join(outputDir, "results.csv"),
      convertToCSV(result.data)
    );

    // If downloadAll, save organized folders with media
    if (downloadAll && result.data.length > 0) {
      job.phase = "downloading";
      job.status = "downloading";
      job.logs.push("Starting media download...");

      const stats = await saveAllAds(result.data, outputDir, (event) => {
        if (event.type === "download_progress") {
          job.downloadProgress = {
            current: event.current,
            total: event.total,
            mediaFiles: event.mediaFiles,
            bytes: event.bytes,
            skipped: event.skipped || 0,
          };
        }
      });

      job.downloadStats = stats;
      job.logs.push(`Download complete: ${stats.totalAds} ads from ${stats.advertisers} advertisers, ${stats.totalMedia} media files, ${formatBytes(stats.totalBytes)}`);
      job.logs.push(`Saved to: ${outputDir}`);
    }

    job.status = "completed";
    job.phase = "done";
    job.completedAt = new Date().toISOString();
  } catch (err) {
    if (err.name === "AbortError" || job.abortController.signal.aborted) {
      job.status = "cancelled";
      job.error = "Scrape cancelled by user";
      job.completedAt = new Date().toISOString();
      console.log(`[scrape:${mode}] Cancelled by user`);
    } else {
      job.status = "error";
      job.error = err.message;
      console.error(`[scrape:${mode}] Error:`, err);
    }
  }
});

app.post("/scrape/cancel/:jobId", (req, res) => {
  const job = scrapeJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  if (job.status !== "running" && job.status !== "downloading") {
    return res.json({ status: job.status, message: "Job is not running" });
  }
  job.abortController.abort();
  res.json({ status: "cancelling" });
});

app.get("/scrape/status/:jobId", (req, res) => {
  const job = scrapeJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json({
    id: job.id,
    status: job.status,
    phase: job.phase,
    phaseDetail: job.phaseDetail,
    mode: job.mode,
    downloadAll: job.downloadAll,
    outputDir: job.downloadAll ? path.basename(path.dirname(job.outputDir)) + "/" + path.basename(job.outputDir) : null,
    progress: job.progress,
    downloadProgress: job.downloadProgress,
    downloadStats: job.downloadStats,
    logs: job.logs,
    error: job.error,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    resultCount: job.result?.data?.length || 0,
  });
});

app.get("/scrape/results/:jobId", (req, res) => {
  const job = scrapeJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  if (job.status !== "completed") {
    return res.status(400).json({ error: "Job not completed yet", status: job.status });
  }
  res.json(job.result);
});

app.get("/scrape/download/:jobId/:format", (req, res) => {
  const job = scrapeJobs.get(req.params.jobId);
  if (!job || job.status !== "completed") {
    return res.status(404).json({ error: "Job not found or not completed" });
  }

  const { format } = req.params;
  const outputDir = job.outputDir;

  if (format === "json") {
    const filePath = path.join(outputDir, "results.json");
    if (fs.existsSync(filePath)) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="ads-${job.id}.json"`);
      return res.sendFile(filePath);
    }
  } else if (format === "csv") {
    const filePath = path.join(outputDir, "results.csv");
    if (fs.existsSync(filePath)) {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="ads-${job.id}.csv"`);
      return res.sendFile(filePath);
    }
  }

  res.status(400).json({ error: "Invalid format. Use json or csv" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + " " + sizes[i];
}

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log("");
  console.log("Endpoints:");
  console.log("  GET  /                          - Home");
  console.log("  POST /scrape                    - Scrape ads");
  console.log("  GET  /scrape/status/:jobId      - Check scrape job status");
  console.log("  GET  /scrape/results/:jobId     - Get scrape results");
  console.log("  GET  /scrape/download/:id/:fmt  - Download results (json/csv)");
  console.log("  GET  /health                    - Health check");
});
