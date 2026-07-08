// Real-browser verification of the local-first console.
// Usage: node verify-browser.mjs <url> [--staticrypt-password dcp]
import { chromium } from "playwright-core";

const EXECUTABLE =
  process.env.BROWSER_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2];
const pwIndex = process.argv.indexOf("--staticrypt-password");
const password = pwIndex >= 0 ? process.argv[pwIndex + 1] : null;

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const errors = [];
const notFound = [];
page.on("pageerror", (e) => errors.push("pageerror: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console.error: " + m.text());
});
page.on("response", (r) => {
  if (r.status() === 404) notFound.push(r.url());
});

const log = (...a) => console.log(...a);
async function clickView(name) {
  await page.click(`#app-nav >> text=${name}`);
  await page.waitForTimeout(700);
}
try {
  await page.goto(url, { waitUntil: "load", timeout: 30000 });

  if (password) {
    await page.waitForSelector("#staticrypt-password, input[type=password]", { timeout: 10000 });
    await page.fill("#staticrypt-password, input[type=password]", password);
    await page.click("button[type=submit], #staticrypt-form button, input[type=submit]");
    await page.waitForTimeout(1500);
    log("STEP staticrypt: submitted password");
  }

  await page.waitForSelector('input[placeholder*="Org name" i]', { timeout: 30000 });
  log("STEP boot: first-run screen rendered (identity + WASM ok)");

  await page.fill('input[placeholder*="Org name" i]', "Phone Test Org");
  await page.click("text=Create a new org");

  await page.waitForSelector("#app-nav", { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelectorAll("#app-nav a, #app-nav button").length >= 5,
    { timeout: 20000 }
  );
  const navItems = await page.$$eval("#app-nav a, #app-nav button", (els) =>
    els.map((e) => e.textContent.trim()).filter(Boolean)
  );
  log("STEP console: nav =", JSON.stringify(navItems));

  // Visit each view; note errors per view.
  for (const v of ["Dashboard", "Intake", "Outreach", "Distros", "Admin", "Roster", "Check-in"]) {
    const before = errors.length;
    await clickView(v);
    const delta = errors.length - before;
    log(`STEP view ${v}: ${delta ? delta + " new error(s)" : "clean"}`);
  }

  // Full intake -> lookup round trip through the CRDT adapter.
  await clickView("Intake");
  await page.fill('input[placeholder*="555" i], input[type=tel]', "(718) 555-0142");
  const nameInput = await page.$('input[placeholder*="First name" i], #intake-name');
  if (nameInput) await nameInput.fill("Ana Test");
  // pick the Soap chip if present
  const soap = await page.$('text=Soap & Shower');
  if (soap) await soap.click();
  await page.click("text=Submit intake");
  await page.waitForTimeout(1200);
  const intakeResult = await page.innerText("#intake-result").catch(() => "");
  log("STEP intake: submitted; result shows household:", /household/i.test(intakeResult) || intakeResult.length > 0);

  await clickView("Check-in");
  await page.fill('#checkin-phone, input[type=tel]', "718-555-0142");
  await page.click("text=Look up");
  await page.waitForTimeout(1000);
  const checkinText = await page.innerText("#checkin-result").catch(() => "");
  log("STEP lookup: found the household:", /Ana Test|Open requests|soap/i.test(checkinText));

  log("RESULT: OK");
} catch (e) {
  log("RESULT: FAIL — " + e.message);
} finally {
  if (notFound.length) log("---- 404s: " + [...new Set(notFound.map((u) => u.replace(/^https?:\/\/[^/]+/, "")))].join(", "));
  if (errors.length) {
    log("---- page/console errors (" + errors.length + ") ----");
    for (const e of [...new Set(errors)].slice(0, 12)) log("  " + e);
  } else {
    log("---- no page/console errors ----");
  }
  await browser.close();
}
