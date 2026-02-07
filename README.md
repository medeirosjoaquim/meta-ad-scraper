# Meta Ads Library Scraper

Scrape, download, and organize ads from Meta's Ad Library. Supports bulk media downloads with organized folder structures, resume across runs, and optional Facebook authentication for full access to age-gated ads.

## Features

- **Two scraper engines** — GraphQL (fast, intercepts API responses) and Playwright (DOM-based fallback)
- **Bulk download** with organized folder structure grouped by advertiser
- **Resume mechanism** — continue where you left off across runs, skipping previously scraped ads
- **Authenticated mode** via saved Facebook cookies (for age-gated ad media access)
- **Real-time progress UI** with live logs, rate-limit handling, and cancel support
- **DOM fallback** — automatically extracts ads from rendered HTML when GraphQL is rate-limited
- **Summary analytics tool** — table view of downloaded companies, ads, images, and videos
- **JSON + CSV export** for every scrape

## Quick Start

**Prerequisites:** Node.js 18+, npm

```bash
npm install
npx playwright install chromium
npm start
```

Open [http://localhost:7676](http://localhost:7676) in your browser.

The web UI has a single form: enter a search query, pick a country and filters, toggle download options, and hit Start. Progress, logs, and results appear in real time.

## Authentication (Optional)

Without authentication, the scraper works but age-gated ads will have no media (images/videos).

To authenticate:

```bash
npm run login
```

This opens a Chromium browser window. Log into Facebook, then wait — once you reach the home page, the browser auto-detects the session and saves your cookies.

- Cookies are saved to `cookies.json` in the project root
- This file is gitignored and never committed
- Future scrapes automatically load these cookies for authenticated access

## Usage — Web UI

The form fields:

| Field | Description |
|---|---|
| **Search Query** | Keyword, advertiser name, or topic to search |
| **Country** | Target country for the Ad Library (default: US) |
| **Sort By** | `impressions` (most impressions first) or `newest` |
| **Status** | `active`, `inactive`, or `all` |
| **Max Ads** | Number of ads to collect (1–1000) |
| **Scraper Engine** | `GraphQL` (recommended, faster) or `Playwright` (DOM-based) |
| **Download All** | When ON, downloads all media (images, videos) organized by advertiser |
| **Start Fresh** | When ON, ignores resume state and re-scrapes from scratch |

### Progress tracking

- Live progress bar shows ads collected vs target
- Log panel streams scraper events (browser launch, scrolling, rate limits, etc.)
- Download phase shows media file count and bytes transferred
- Cancel button aborts the scrape at any point (cancelled scrapes don't update resume state)

## Resume Mechanism

When **Download All** is enabled, the scraper saves state between runs:

1. A fingerprint is computed from `query + country + status + sort`
2. State files are stored in `downloads/.state/{fingerprint}.json`
3. On the next run with the same parameters, previously scraped ad IDs are skipped
4. New ads are collected and merged into the existing download folder
5. The `_summary.json`, `_summary.csv`, `results.json`, and `results.csv` files are merged with existing data

**Start Fresh** resets the state for that query, re-scraping everything from scratch. Cancelled scrapes never update state files.

## Output Structure

### Download All mode

```
downloads/{query}_{country}_{status}/
  ads/
    {advertiser_name}/
      {ad_id}/
        ad.json          # Full ad data
        ad-copy.txt      # Human-readable ad text
        image_0.jpg      # Ad images
        image_1.png
        video_0.mp4      # Ad videos
        video_0_thumb.jpg
    _summary.json        # All ads merged across runs
    _summary.csv
  results.json           # Scrape results (merged)
  results.csv
```

Ads are grouped by advertiser name (sanitized to filesystem-safe folder names).

### Regular mode (Download All off)

```
output/{jobId}/
  results.json
  results.csv
```

## Summary Tool

View a table of everything you've downloaded:

```bash
npm run summary
```

```
═══════════════════════════════════════════════════════════════
  META ADS SCRAPER — DOWNLOAD SUMMARY
═══════════════════════════════════════════════════════════════

  Companies:    12
  Total Ads:    347
  Total Media:  891  (654 images, 237 videos)

───────────────────────────────────────────────────────────────
  Company                                    Ads   Imgs   Vids
───────────────────────────────────────────────────────────────
  Nike                                        87    120     45
  Adidas                                      63     95     32
  ...
═══════════════════════════════════════════════════════════════
```

## API Reference

All endpoints are served from `http://localhost:{PORT}`.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/scrape` | Start a scrape job |
| `GET` | `/scrape/status/:jobId` | Poll job status, progress, and logs |
| `GET` | `/scrape/results/:jobId` | Get full results (only when job is completed) |
| `GET` | `/scrape/download/:jobId/:format` | Download results as `json` or `csv` |
| `POST` | `/scrape/cancel/:jobId` | Cancel a running job |
| `GET` | `/scrape/countries` | List supported country codes |
| `GET` | `/health` | Health check (`{ "status": "ok" }`) |

### POST /scrape — Request body

```json
{
  "query": "nike shoes",
  "country": "US",
  "activeStatus": "active",
  "adType": "all",
  "mediaType": "all",
  "sortBy": "impressions",
  "maxAds": 50,
  "downloadMedia": false,
  "downloadAll": false,
  "startFresh": false,
  "mode": "graphql"
}
```

Returns `{ "jobId": "...", "status": "started", "mode": "graphql", "downloadAll": false }`.

### GET /scrape/status/:jobId — Response

```json
{
  "id": "abc123",
  "status": "running",
  "phase": "scraping",
  "phaseDetail": "Scrolling for more ads...",
  "mode": "graphql",
  "downloadAll": true,
  "progress": { "current": 35, "max": 100 },
  "downloadProgress": null,
  "downloadStats": null,
  "resumeInfo": { "previousAds": 50, "newAds": 0 },
  "logs": ["Launching browser...", "..."],
  "error": null,
  "startedAt": "2025-01-15T10:00:00.000Z",
  "completedAt": null,
  "resultCount": 35
}
```

Job statuses: `running` → `downloading` → `completed`, or `error`, or `cancelled`.

## Configuration

| File | Purpose |
|---|---|
| `.env` | `PORT` — server port (default `7676`) |
| `cookies.json` | Facebook session cookies, created by `npm run login` (gitignored) |

## NPM Scripts

| Script | Command | Description |
|---|---|---|
| `start` | `node server.js` | Start the server |
| `dev` | `node server.js` | Start the server (same as start) |
| `login` | `node login.js` | Open browser to save Facebook cookies |
| `summary` | `node summary.js` | Print download summary table |

## Rate Limiting

Facebook rate-limits GraphQL requests to the Ad Library. The scraper handles this automatically:

1. Detects HTTP 429 responses and GraphQL error codes (`1675004`)
2. Applies exponential backoff (30s, 60s, 120s)
3. Falls back to DOM extraction when GraphQL is blocked
4. Retries with page reload after backoff periods
5. Stops gracefully after 3 consecutive rate-limit hits

Additionally, the server enforces a maximum of **2 concurrent scrape jobs** to reduce rate-limit risk.

## Supported Countries

```
US  United States        BR  Brazil               GB  United Kingdom
CA  Canada               AU  Australia             DE  Germany
FR  France               IT  Italy                 ES  Spain
IN  India                MX  Mexico                JP  Japan
AR  Argentina            CO  Colombia              CL  Chile
PT  Portugal             NL  Netherlands           SE  Sweden
NO  Norway               DK  Denmark               FI  Finland
PL  Poland               IE  Ireland               NZ  New Zealand
ZA  South Africa         NG  Nigeria               KE  Kenya
EG  Egypt                SA  Saudi Arabia          AE  United Arab Emirates
IL  Israel               TR  Turkey                KR  South Korea
TW  Taiwan               PH  Philippines           TH  Thailand
VN  Vietnam              ID  Indonesia             MY  Malaysia
SG  Singapore            ALL All Countries
```

38 options total (37 countries + ALL).
