const fs = require("fs");
const path = require("path");
const root = process.cwd();

// 1) nav page paths from docs.json -> file must exist
const cfg = JSON.parse(fs.readFileSync("docs.json", "utf8"));
const navPages = [];
(function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk);
  if (o && typeof o === "object") {
    if (Array.isArray(o.pages)) o.pages.forEach(p => (typeof p === "string" ? navPages.push(p) : walk(p)));
    Object.values(o).forEach(walk);
  }
})(cfg.navigation);
const missingNav = navPages.filter(p => !fs.existsSync(path.join(root, p + ".mdx")));
console.log("nav pages:", navPages.length, "| missing files:", missingNav.length, missingNav.join(", "));

// 2) every internal link in every .mdx must resolve to a file
function allMdx(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(allMdx(f));
    else if (e.name.endsWith(".mdx")) out.push(f);
  }
  return out;
}
const files = allMdx(root);
const linkRe = /(?:href="|\]\()(\/[A-Za-z0-9/_-]+)(?:"|\))/g;
let broken = [], total = 0;
for (const f of files) {
  const c = fs.readFileSync(f, "utf8");
  let m;
  while ((m = linkRe.exec(c))) {
    const link = m[1];
    total++;
    if (link === "/") continue;
    if (!fs.existsSync(path.join(root, link.slice(1) + ".mdx"))) broken.push(path.relative(root, f) + " -> " + link);
  }
}
console.log("internal links checked:", total, "| unresolved on disk:", broken.length);
broken.slice(0, 40).forEach(b => console.log("  BROKEN:", b));
