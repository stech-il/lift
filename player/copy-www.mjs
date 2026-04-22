/**
 * מעתיק את נכסי הווב ל־www לפני cap sync (Capacitor דורש תיקייה נקייה).
 * ברירת מחדל: player-v2 (פריסה עדכנית). אם אין תיקייה — נופלים ל־player.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const out = path.join(root, "www");
const files = ["index.html", "styles.css", "renderer.js"];

const srcV2 = path.join(root, "..", "player-v2");
const srcRoot =
  fs.existsSync(path.join(srcV2, "index.html")) && fs.existsSync(path.join(srcV2, "renderer.js"))
    ? srcV2
    : root;

fs.mkdirSync(out, { recursive: true });
for (const f of files) {
  const src = path.join(srcRoot, f);
  if (!fs.existsSync(src)) {
    console.error("Missing:", src);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(out, f));
}
console.log("Copied web assets to www/ from:", path.relative(root, srcRoot) || ".");
