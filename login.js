const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const COOKIES_PATH = path.join(__dirname, "cookies.json");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function login() {
  console.log("Opening browser — log into Facebook, then close the browser when done.\n");

  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });

  const page = await context.newPage();
  await page.goto("https://www.facebook.com/login", { waitUntil: "domcontentloaded" });

  console.log("Waiting for you to log in...");
  console.log("(The browser will detect when you reach the Facebook home page)\n");

  // Wait until the user is logged in — detect by URL change away from /login
  // or by presence of logged-in cookies (c_user)
  try {
    await page.waitForFunction(
      () => {
        return (
          !window.location.pathname.includes("/login") &&
          !window.location.pathname.includes("/checkpoint") &&
          document.cookie.includes("c_user")
        );
      },
      { timeout: 300000 } // 5 minute timeout
    );
  } catch {
    // If the function check doesn't work (cross-origin), fall back to URL-based detection
    await page.waitForURL(
      (url) => {
        const p = url.pathname;
        return p === "/" || p === "/home.php" || p.startsWith("/?");
      },
      { timeout: 300000 }
    );
  }

  // Give the page a moment to set all cookies
  await page.waitForTimeout(3000);

  const cookies = await context.cookies();
  const fbCookies = cookies.filter((c) =>
    c.domain.includes("facebook.com") || c.domain.includes(".facebook.com")
  );

  fs.writeFileSync(COOKIES_PATH, JSON.stringify(fbCookies, null, 2));
  console.log(`\nSaved ${fbCookies.length} cookies to ${COOKIES_PATH}`);
  console.log("You can close this terminal. Future scrapes will use these cookies.\n");

  await browser.close();
}

login().catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});
