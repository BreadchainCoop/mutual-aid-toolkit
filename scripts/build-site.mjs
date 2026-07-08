// Assemble the public site: a Bread marketing landing page at the root, with
// the self-contained single-file app served under /app/.
//
//   dist-site/
//     index.html      <- web/landing/index.html, with the Pogaca fonts inlined
//     app/index.html  <- dist-single/index.html (the built console)
//
// Run `npm run build:single` first so dist-single/ exists (build:site does).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s) => resolve(root, ...s);

const appBundle = p("dist-single", "index.html");
if (!existsSync(appBundle)) {
  console.error("dist-single/index.html not found — run `npm run build:single` first.");
  process.exit(1);
}

// Inline the base64 @font-face rules into the landing so it is self-contained
// and offline-safe, exactly like the app bundle.
const fonts = readFileSync(p("web", "console", "fonts.css"), "utf8");
let landing = readFileSync(p("web", "landing", "index.html"), "utf8");
if (!landing.includes("/*__FONTS__*/")) {
  console.error("landing template is missing the /*__FONTS__*/ placeholder.");
  process.exit(1);
}
landing = landing.replace("/*__FONTS__*/", fonts);

const out = p("dist-site");
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, "app"), { recursive: true });

writeFileSync(resolve(out, "index.html"), landing);
copyFileSync(appBundle, resolve(out, "app", "index.html"));
// GitHub Pages: don't run the content through Jekyll.
writeFileSync(resolve(out, ".nojekyll"), "");

const kb = (f) => Math.round(readFileSync(f).length / 1024);
console.log(`dist-site assembled:`);
console.log(`  index.html    ${kb(resolve(out, "index.html"))} kB  (landing + inlined fonts)`);
console.log(`  app/index.html ${kb(resolve(out, "app", "index.html"))} kB  (console bundle)`);
