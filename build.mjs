// Builds the site into dist/: the landing page with the latest release's download links, the
// guides, support, and a changelog made from the app's GitHub Releases. No dependencies.
//
//   node build.mjs            build (fetches releases; falls back to content/releases.json)
//   node build.mjs --offline  build from content/releases.json only

import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const REPO = "Sagacious123/hearken-studio";
const GH = `https://github.com/${REPO}`;
const OUT = "dist";
const offline = process.argv.includes("--offline");

// ---------- releases ----------

/** Published releases, newest first: { version, date, body, assets: [{ name, url, size }] }. */
async function loadReleases() {
  const cache = "content/releases.json";
  if (!offline) {
    try {
      const headers = { "User-Agent": "hearken-site", Accept: "application/vnd.github+json" };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, { headers });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const releases = (await res.json())
        .filter((r) => !r.draft && !r.prerelease)
        .map((r) => ({
          version: r.tag_name.replace(/^v/, ""),
          date: r.published_at,
          body: r.body ?? "",
          assets: r.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
        }));
      await writeFile(cache, JSON.stringify(releases, null, 1) + "\n");
      console.log(`releases: ${releases.length} from GitHub (latest ${releases[0]?.version})`);
      return releases;
    } catch (e) {
      console.warn(`releases: couldn't reach GitHub (${e.message}); using ${cache}`);
    }
  }
  return JSON.parse(await readFile(cache, "utf8"));
}

/** Which file each download button offers. */
const DOWNLOADS = {
  "mac-arm": /_aarch64\.dmg$/,
  "mac-intel": /_x64\.dmg$/,
  "win-exe": /-setup\.exe$/,
  "win-msi": /\.msi$/,
  "linux-appimage": /\.AppImage$/,
  "linux-deb": /\.deb$/,
  "linux-rpm": /\.rpm$/,
};

function fillDownloads(html, releases) {
  const latest = releases[0];
  const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
  return html.replace(/\{\{(version|url|size)(?::([\w-]+))?\}\}/g, (_, what, key) => {
    if (what === "version") return latest.version;
    const asset = latest.assets.find((a) => DOWNLOADS[key]?.test(a.name));
    if (!asset) {
      // A platform missing from this release: send people to the release page instead.
      console.warn(`downloads: no ${key} file in ${latest.version}`);
      return what === "url" ? `${GH}/releases/latest` : "see all downloads";
    }
    return what === "url" ? asset.url : mb(asset.size);
  });
}

// ---------- a little Markdown (release notes) ----------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const curly = (s) => s.replace(/(^|[\s(])"/g, "$1“").replace(/"/g, "”").replace(/'/g, "’");
const inline = (s) =>
  esc(curly(s))
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');

/** Headings, lists and paragraphs. The "What's new" title and the Installing section are left
 *  out: the page has its own version heading, and the download section covers installing. */
function markdown(md) {
  const out = [];
  let list = false;
  let skipping = false;
  const close = () => list && (out.push("</ul>"), (list = false));
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^(#{2,4})\s+(.*)$/);
    if (heading) {
      close();
      skipping = /^install/i.test(heading[2]);
      if (heading[1] !== "##" && !skipping) out.push(`<h3>${inline(heading[2])}</h3>`);
      continue;
    }
    if (skipping) continue;
    const item = line.match(/^[-*]\s+(.*)$/);
    if (item) {
      if (!list) out.push("<ul>"), (list = true);
      out.push(`<li>${inline(item[1])}</li>`);
    } else if (!line) close();
    else close(), out.push(`<p>${inline(line)}</p>`);
  }
  close();
  return out.join("");
}

/** The workflow's placeholder text, before notes are written for a release. */
const PLACEHOLDER = /^See the assets below to download/;

// ---------- pages ----------

const LOGO =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3c3 4.5 5 7.2 5 10.2A5 5 0 0 1 16 18a5 5 0 0 1-5-4.8C11 10.2 13 7.5 16 3z" fill="#e9b24c"/><path d="M6 22c3.3-1.6 6.7-1.6 10 0 3.3-1.6 6.7-1.6 10 0v6c-3.3-1.6-6.7-1.6-10 0-3.3-1.6-6.7-1.6-10 0z" fill="#f4ede1"/></svg>';

const NAV = [
  ["Features", "/#features"],
  ["Pricing", "/#pricing"],
  ["Support", "/support"],
  ["Blog", "/blog"],
  ["Changelog", "/changelog"],
];

function page({ title, current, description, body }) {
  const links = NAV.map(([name, href]) => `<a href="${href}"${name === current ? ' aria-current="page"' : ""}>${name}</a>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title><meta name="description" content="${esc(description)}">
<meta property="og:title" content="${title}"><meta property="og:description" content="${esc(description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=EB+Garamond:ital,wght@0,400;1,400&family=Manrope:wght@200;300;400;500;600;700;800&display=swap">
<link rel="stylesheet" href="/site.css"></head>
<body>
<nav class="top" aria-label="Main"><a class="brand" href="/">${LOGO}HEARKEN</a><div class="links">${links}</div><div class="right"><a class="go" href="/#download">Download free</a></div></nav>
<main>${body}</main>
<footer><em>“Thy word is a lamp unto my feet, and a light unto my path.” Psalm 119:105</em>
<span>${NAV.map(([n, h]) => `<a href="${h}">${n}</a>`).join(" · ")} · <a href="${GH}">GitHub</a></span></footer>
</body></html>
`;
}

const card = (g, tag = "h2") =>
  `<a class="card" href="/guide-${g.slug}"><span class="cat">${g.category} · ${g.minutes}</span><${tag}>${g.title}</${tag}><p>${g.blurb}</p><span class="more">Read →</span></a>`;

function blogPages(guides) {
  const files = {};
  files["blog.html"] = page({
    title: "Blog · Hearken Studio",
    current: "Blog",
    description: "Step-by-step guides for setting up Hearken Studio.",
    body: `<div class="wrap"><header class="head"><p class="eyebrow">Blog</p><h1>Guides for the media desk.</h1>
<p class="lede">Short, step-by-step articles for getting the sound, screens and phones ready before Sunday.</p></header>
<div class="cards">${guides.map((g) => card(g)).join("")}</div></div>`,
  });
  for (const g of guides) {
    const others = guides.filter((o) => o !== g).slice(0, 3);
    files[`guide-${g.slug}.html`] = page({
      title: `${g.title} · Hearken Studio`,
      current: "Blog",
      description: g.blurb,
      body: `<div class="wrap narrow"><header class="head" style="padding-bottom:10px"><a class="back" href="/blog">← All guides</a></header>
<article class="article"><p class="meta">${g.category} · ${g.minutes} read</p><h1>${g.title}</h1>${g.body}</article>
<section class="next"><h2>MORE GUIDES</h2><div class="cards" style="grid-template-columns:minmax(0,1fr)">${others.map((o) => card(o, "h3")).join("")}</div></section></div>`,
    });
  }
  return files;
}

async function changelogPage(releases) {
  const date = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const local = async (version) => {
    const f = `content/changelog/${version}.md`;
    return existsSync(f) ? readFile(f, "utf8") : null;
  };
  const entries = [];

  // What's coming, until that version is released.
  const upcoming = await readFile("content/upcoming.md", "utf8").catch(() => "");
  const front = upcoming.match(/^---\n([\s\S]*?)\n---\n/);
  const next = front?.[1].match(/version:\s*(\S+)/)?.[1];
  if (next && !releases.some((r) => r.version === next)) {
    entries.push(`<div class="rel upcoming"><div class="v"><h2>${next}</h2><span class="badge">Coming next</span></div>${markdown(upcoming.slice(front[0].length))}</div>`);
  }

  for (const r of releases) {
    // Notes written here win; then the release's own notes; then a link to the release.
    const notes = (await local(r.version)) ?? (PLACEHOLDER.test(r.body.trim()) ? "" : r.body);
    const html = notes ? markdown(notes) : `<p><a href="${GH}/releases/tag/v${r.version}">Download and details on GitHub</a></p>`;
    entries.push(`<div class="rel"><div class="v"><h2>${r.version}</h2><span>${date(r.date)}</span></div>${html}</div>`);
  }

  return page({
    title: "Changelog · Hearken Studio",
    current: "Changelog",
    description: "Every Hearken Studio release and what changed.",
    body: `<div class="wrap narrow"><header class="head"><p class="eyebrow">Changelog</p><h1>What’s new.</h1>
<p class="lede">Installed copies offer each update by themselves. Click <b>Install &amp; restart</b> when you’re not listening.</p></header>
<div class="log">${entries.join("\n")}</div></div>`,
  });
}

function supportPage(faq) {
  return page({
    title: "Support · Hearken Studio",
    current: "Support",
    description: "Answers and help for Hearken Studio.",
    body: `<div class="wrap"><header class="head"><p class="eyebrow">Support</p><h1>Help before Sunday.</h1>
<p class="lede">Answers to the questions media teams ask most, and where to go when something isn’t working.</p></header>
<div class="split"><div class="faq">${faq.map(({ q, a }) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</div>
<aside class="side"><h2>STILL STUCK?</h2>
<a class="card" href="${GH}/issues" target="_blank" rel="noopener"><h3>Report a problem →</h3><p>Open an issue on GitHub with what happened and what you expected. Screenshots help.</p></a>
<a class="card" href="/blog"><h3>Read the guides →</h3><p>Step-by-step articles for the sound, screens, phones and the remote.</p></a>
<a class="card" href="/changelog"><h3>See what’s changed →</h3><p>Your problem may already be fixed in a newer version.</p></a></aside></div></div>`,
  });
}

// ---------- build ----------

const releases = await loadReleases();
if (!releases.length) throw new Error("no published releases to link to");
const guides = JSON.parse(await readFile("content/guides.json", "utf8"));
const faq = JSON.parse(await readFile("content/faq.json", "utf8"));

const files = {
  "index.html": fillDownloads(await readFile("src/index.html", "utf8"), releases),
  ...blogPages(guides),
  "changelog.html": await changelogPage(releases),
  "support.html": supportPage(faq),
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const f of await readdir("src")) if (f !== "index.html") await cp(`src/${f}`, `${OUT}/${f}`, { recursive: true });
for (const [name, html] of Object.entries(files)) {
  const left = html.match(/\{\{[^}]+\}\}/);
  if (left) throw new Error(`${name}: unfilled ${left[0]}`);
  await writeFile(`${OUT}/${name}`, html);
}
console.log(`built ${Object.keys(files).length} pages into ${OUT}/`);
