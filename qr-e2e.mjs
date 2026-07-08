// Browser e2e for QR onboarding:
//   context A (admin): create org -> Roster view -> mint QR invite -> capture URL
//   context B (fresh "phone"): open the invite URL -> name yourself -> Join
//   assert: B's console boots with the org; A sees the new volunteer.
import { chromium } from "playwright-core";

const APP = "http://127.0.0.1:8795/";
const RELAY = "ws://127.0.0.1:8944";
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const log = (...a) => console.log(...a);

try {
  // ---- Admin context ------------------------------------------------------
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  a.on("pageerror", (e) => log("A pageerror:", String(e.message).slice(0, 100)));
  await a.goto(APP, { waitUntil: "load" });
  await a.waitForSelector('input[placeholder*="Org name" i]', { timeout: 30000 });
  await a.fill('input[placeholder*="Org name" i]', "QR Browser Org");
  // set the relay endpoint on the CREATE form (first matching optional field)
  await a.fill('input[placeholder*="optional — needed to sync" i]', RELAY);
  await a.click("text=Create a new org");
  await a.waitForFunction(
    () => document.querySelectorAll("#app-nav a, #app-nav button").length >= 5,
    { timeout: 30000 }
  );
  log("STEP A: org created, console up");

  await a.click('#app-nav >> text=Roster');
  await a.waitForSelector("text=QR invite", { timeout: 15000 });
  await a.fill("#invite-name", "Playwright distro");
  await a.click("text=Create QR invite");
  await a.waitForSelector("canvas", { timeout: 15000 });
  log("STEP A: QR canvas rendered");

  // Capture the invite URL via a patched clipboard.
  await a.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.writeText = (t) => {
      window.__copied = t;
      return Promise.resolve();
    };
  });
  await a.click("text=Copy invite link");
  const inviteUrl = await a.evaluate(() => window.__copied);
  if (!inviteUrl || !inviteUrl.includes("#invite=")) throw new Error("no invite URL captured");
  log("STEP A: invite URL captured, length", inviteUrl.length);
  // Point it at our served app instead of the deployed demo host.
  const localInvite = APP + inviteUrl.slice(inviteUrl.indexOf("#invite="));

  // Wait for the invite to replicate to the relay.
  await a.waitForTimeout(4000);

  // ---- Volunteer context (fresh profile = a new phone) --------------------
  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  b.on("pageerror", (e) => log("B pageerror:", String(e.message).slice(0, 100)));
  await b.goto(localInvite, { waitUntil: "load" });
  await b.waitForSelector("#invite-device-name", { timeout: 30000 });
  log("STEP B: invite screen shown");
  await b.fill("#invite-device-name", "Playwright volunteer");
  await b.click("#invite-join-btn");
  try {
    await b.waitForFunction(
      () => document.querySelectorAll("#app-nav a, #app-nav button").length >= 5,
      { timeout: 90000 }
    );
  } catch (e) {
    const bootText = await b.evaluate(() => (document.getElementById("boot-root")?.innerText ?? document.body.innerText).slice(0, 300));
    throw new Error("B did not boot; screen says: " + bootText);
  }
  log("STEP B: console booted after QR join");
  await b.click('#app-nav >> text=Roster');
  await b.waitForTimeout(600);
  const orgSeen = await b.evaluate(() => document.body.innerText.includes("QR Browser Org"));

  // B should be a functioning volunteer: the api answers.
  const bamState = await b.evaluate(() => ({ type: typeof window.BAM, keys: window.BAM ? Object.keys(window.BAM).slice(0, 8) : null, navItems: document.querySelectorAll('#app-nav a, #app-nav button').length }));
  log("STEP B: window.BAM =", JSON.stringify(bamState));
  const counts = await b.evaluate(async () => {
    const w = window;
    if (!w.BAM || !w.BAM.api) return -1;
    return (await w.BAM.api.openRequests()).counts.length;
  });
  log("STEP B: api works, open-request types =", counts);

  // ---- Admin sees the volunteer -------------------------------------------
  await a.waitForTimeout(4000);
  await a.click('#app-nav >> text=Check-in'); // navigate away and back to re-render
  await a.click('#app-nav >> text=Roster');
  await a.waitForFunction(
    () => document.body.innerText.includes("Playwright volunteer"),
    { timeout: 20000 }
  );
  const roleShown = await a.evaluate(() =>
    /Playwright volunteer[\s\S]{0,80}volunteer/.test(document.body.innerText)
  );
  log("STEP A: roster shows the QR-joined device (role volunteer:", roleShown, ")");
  log(orgSeen ? "RESULT: QR ONBOARDING OK (browser end-to-end)" : "RESULT: joined but org name not visible");
} catch (e) {
  log("RESULT: FAIL —", e.message);
} finally {
  await browser.close();
}
