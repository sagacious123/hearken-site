// Builds the site into dist/: the landing page with the latest release's download links, the
// guides, support, and a changelog made from the app's GitHub Releases. No dependencies.
//
//   node build.mjs            build (fetches releases; falls back to content/releases.json)
//   node build.mjs --offline  build from content/releases.json only

import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

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
  '<svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="hk-gold" gradientUnits="userSpaceOnUse" x1="30" y1="6" x2="70" y2="94"><stop offset="0" stop-color="#fbe7b5"/><stop offset=".48" stop-color="#e9b24c"/><stop offset="1" stop-color="#b07a24"/></linearGradient></defs><g fill="url(#hk-gold)"><path d="M11 10H39V14.5C35 14.5 33 16.5 33 20.5V79.5C33 83.5 35 85.5 39 85.5V90H11V85.5C15 85.5 17 83.5 17 79.5V20.5C17 16.5 15 14.5 11 14.5Z"/><path d="M61 10H89V14.5C85 14.5 83 16.5 83 20.5V79.5C83 83.5 85 85.5 89 85.5V90H61V85.5C65 85.5 67 83.5 67 79.5V20.5C67 16.5 65 14.5 61 14.5Z"/><circle cx="50" cy="38.5" r="7.75"/><circle cx="50" cy="61.5" r="7.75"/></g></svg>';

const NAV = [
  ["Features", "/#features"],
  ["Pricing", "/#pricing"],
  ["Manual", "/manual"],
  ["Support", "/support"],
  ["Blog", "/blog"],
  ["Changelog", "/changelog"],
  ["Account", "/account"],
];

function page({ title, current, description, body, head = "" }) {
  const links = NAV.map(([name, href]) => `<a href="${href}"${name === current ? ' aria-current="page"' : ""}>${name}</a>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title><meta name="description" content="${esc(description)}">
<meta property="og:title" content="${title}"><meta property="og:description" content="${esc(description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=EB+Garamond:ital,wght@0,400;1,400&family=Manrope:wght@200;300;400;500;600;700;800&display=swap">
<link rel="stylesheet" href="/site.css">${head}</head>
<body>
<nav class="top" aria-label="Main"><a class="brand" href="/">${LOGO}HEARKEN</a><div class="links" id="site-links">${links}<a class="links-go" href="/#download">Start free trial</a></div><div class="right"><a class="go" href="/#download">Start free trial</a><button class="menu" type="button" aria-label="Menu" aria-expanded="false" aria-controls="site-links"><span></span><span></span><span></span></button></div></nav>
<main>${body}</main>
<footer><em>“Thy word is a lamp unto my feet, and a light unto my path.” Psalm 119:105</em>
<span>${NAV.map(([n, h]) => `<a href="${h}">${n}</a>`).join(" · ")} · <a href="${GH}">GitHub</a></span></footer>
<script>
// The phone menu: the button opens the links; a link, Esc or a tap elsewhere closes them.
(() => {
  const nav = document.querySelector(".top"), button = nav.querySelector(".menu");
  const set = (open) => { nav.classList.toggle("open", open); button.setAttribute("aria-expanded", open); };
  button.addEventListener("click", () => set(!nav.classList.contains("open")));
  nav.querySelectorAll(".links a").forEach((a) => a.addEventListener("click", () => set(false)));
  addEventListener("keydown", (e) => e.key === "Escape" && set(false));
  addEventListener("click", (e) => !nav.contains(e.target) && set(false));
})();
</script>
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

/** The user manual: content/manual.html, with the contents built from its h2 and h3 headings. */
async function manualPage() {
  // Screenshots are taken at 2x: give each its size in CSS pixels, read from the PNG header.
  const doc = (await readFile("content/manual.html", "utf8")).replace(/<img src="\/(img\/manual\/[\w-]+\.png)"/g, (tag, path) => {
    const png = readFileSync(`src/${path}`);
    return `${tag} width="${png.readUInt32BE(16) / 2}" height="${png.readUInt32BE(20) / 2}"`;
  });
  const toc = [];
  for (const m of doc.matchAll(/<h([23]) id="([\w-]+)">([\s\S]*?)<\/h\1>/g)) {
    const title = m[3].replace(/<span class="n">[\s\S]*?<\/span>/, "").replace(/<[^>]+>/g, "").trim();
    if (m[1] === "2") toc.push({ id: m[2], title, subs: [] });
    else toc.at(-1)?.subs.push({ id: m[2], title });
  }
  const list = toc
    .map((c) => `<li><a href="#${c.id}">${c.title}</a>${c.subs.length ? `<ol>${c.subs.map((s) => `<li><a href="#${s.id}">${s.title}</a></li>`).join("")}</ol>` : ""}</li>`)
    .join("");
  return page({
    title: "User manual · Hearken Studio",
    current: "Manual",
    description: "How to use Hearken Studio, step by step: setting up, listening, putting scripture and songs on screen, phones, livestreams and every setting.",
    body: `<div class="manual"><header class="head"><p class="eyebrow">User manual</p><h1>Everything Hearken does, step by step.</h1>
<p class="lede">From the first install to the end of the service. Read it in order the first time, then come back to any section from the contents.</p></header>
<details class="toc" open><summary>Contents</summary><nav aria-label="Manual contents"><ol>${list}</ol></nav></details>
<article class="doc">${doc}</article></div>
<script>
// On a phone the contents start folded; the section being read is marked in the contents.
if (matchMedia("(max-width: 900px)").matches) document.querySelector(".toc").open = false;
const links = new Map([...document.querySelectorAll(".toc a")].map((a) => [a.hash.slice(1), a]));
const seen = new IntersectionObserver((es) => es.forEach((e) => {
  if (!e.isIntersecting) return;
  links.forEach((a) => a.classList.remove("on"));
  links.get(e.target.id)?.classList.add("on");
}), { rootMargin: "-90px 0px -70% 0px" });
document.querySelectorAll(".doc h2[id], .doc h3[id]").forEach((h) => seen.observe(h));
</script>`,
  });
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

/** The church's account: sign in or create it, then its licence, computers, name and password. */
function accountPage() {
  const field = (id, label, type, extra = "") => `<label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" ${extra}>`;
  return page({
    title: "Account · Hearken Studio",
    current: "Account",
    description: "Your church's Hearken Studio account: its licence, the computers signed in, and its password.",
    body: `<div class="wrap narrow acct">
<p class="lede" id="loading">Loading…</p>
<section id="out" hidden>
<header class="head"><p class="eyebrow">Account</p><h1>Your church’s account.</h1>
<p class="lede">The same account you use in the app. Sign in to see its computers and licence, or create it here and sign in with it in the app.</p></header>
<div class="tabs" role="tablist"><button type="button" role="tab" id="tab-in" aria-selected="true">Sign in</button><button type="button" role="tab" id="tab-new" aria-selected="false">Create an account</button></div>
<form class="form" id="auth" novalidate>
<div id="church-field" hidden>${field("church", "Church name", "text", 'maxlength="120" autocomplete="organization"')}</div>
${field("email", "Email", "email", 'autocomplete="email" required')}
${field("password", "Password", "password", 'autocomplete="current-password" required')}
<p class="hint" id="pw-hint" hidden>At least 8 characters.</p>
<button class="btn" type="submit" id="auth-go">Sign in</button>
<p class="msg" role="status" id="auth-msg"></p>
<button type="button" class="link" id="to-forgot">Forgot your password?</button>
</form>
<form class="form" id="verify" hidden novalidate>
<p>We emailed a 6-digit code to <b id="verify-email"></b>. Enter it to finish creating the account. It expires in 30 minutes.</p>
<label for="verify-code">Code</label><input id="verify-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
<button class="btn" type="submit">Create account</button>
<p class="msg" role="status" id="verify-msg"></p>
<button type="button" class="link" id="verify-again">Send a new code</button>
<button type="button" class="link" id="verify-back">Change the details</button>
</form>
<form class="form" id="forgot" hidden novalidate>
<p>We’ll email you a link to choose a new password.</p>
${field("forgot-email", "Email", "email", 'autocomplete="email" required')}
<button class="btn" type="submit">Email me a link</button>
<p class="msg" role="status" id="forgot-msg"></p>
<button type="button" class="link" id="from-forgot">Back to sign in</button>
</form>
</section>
<section id="in" hidden>
<header class="head"><p class="eyebrow">Account</p><h1 id="church-name"></h1><p class="lede" id="who"></p></header>
<div class="panel notice" id="confirm" hidden><h2>Confirm your email</h2>
<p>This account’s email hasn’t been confirmed yet. We’ll send a code to <b id="confirm-email"></b>, to make sure password resets and licences reach you.</p>
<form class="form inline" id="confirm-form" novalidate><label class="sr" for="confirm-code">Code</label><input id="confirm-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" hidden><button class="btn" type="button" id="confirm-send">Email me a code</button><button class="btn" type="submit" id="confirm-go" hidden>Confirm</button></form>
<p class="msg" role="status" id="confirm-msg"></p></div>
<div class="panel" id="licence"></div>
<div class="panel"><div class="panel-head"><h2>Computers</h2><span id="count"></span></div>
<ul class="computers" id="computers"></ul><p class="hint" id="computers-note"></p></div>
<div class="panel"><h2>Church name</h2><p class="hint">Shown in the app and at the top of sermon recaps.</p>
<form class="form inline" id="rename" novalidate><label for="new-church" class="sr">Church name</label><input id="new-church" name="new-church" type="text" maxlength="120" autocomplete="organization" required><button class="btn ghost" type="submit">Save</button></form>
<p class="msg" role="status" id="rename-msg"></p></div>
<div class="panel"><h2>Password</h2><p class="hint">Computers stay signed in when you change it here. To sign every computer out, use “Forgot your password?” when signed out.</p>
<form class="form" id="password-form" novalidate>
${field("current", "Current password", "password", 'autocomplete="current-password" required')}
${field("next", "New password", "password", 'autocomplete="new-password" minlength="8" required')}
<button class="btn ghost" type="submit">Change password</button>
<p class="msg" role="status" id="password-msg"></p></form></div>
<button type="button" class="btn ghost" id="sign-out">Sign out of this website</button>
</section>
</div>
<script src="/account.js"></script>`,
  });
}

/** The admin dashboard: its own layout (a sidebar, not the site's menu), drawn by /admin.js. */
function adminPage() {
  const icon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICONS = {
    overview: icon('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
    accounts: icon('<path d="M3 21v-1a6 6 0 0 1 12 0v1"/><circle cx="9" cy="8" r="4"/><path d="M17 11a3 3 0 1 0 0-6M21 21v-1a5 5 0 0 0-3-4.6"/>'),
    computers: icon('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'),
    trials: icon('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>'),
    licences: icon('<path d="M15 7a4 4 0 1 1-4 4"/><path d="M11 11 3 19v2h3l1-1v-2h2v-2h2l1.2-1.2"/><circle cx="16.5" cy="7.5" r="1"/>'),
    security: icon('<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  };
  const nav = [["overview", "Overview"], ["accounts", "Accounts"], ["computers", "Computers"], ["trials", "Trials"], ["licences", "Licences"], ["security", "Security"]]
    .map(([id, label]) => `<a href="#${id}" data-view="${id}">${ICONS[id]}<span>${label}</span></a>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Admin · Hearken Studio</title><meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=Manrope:wght@300;400;500;600;700&display=swap">
<link rel="stylesheet" href="/admin.css"></head>
<body>
<div class="gate" id="gate" hidden><div class="gate-card">
<a class="gate-brand" href="/">${LOGO.replaceAll("hk-gold", "hk-gold-gate")}<span>HEARKEN</span></a>
<h1>Admin</h1><p id="gate-text">Loading…</p>
<a class="btn" id="gate-account" href="/account" hidden>Go to the account page</a>
<form id="code-form" hidden novalidate>
<div id="by-app" hidden><label for="app-code">The 6-digit code from your authenticator app</label><input id="app-code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div>
<div id="by-email" hidden><button class="btn ghost" type="button" id="send-code">Email me a code</button>
<div id="code-entry" hidden><label for="code">The 6-digit code from your email</label><input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div></div>
<label class="check" id="trust-row" hidden><input type="checkbox" id="trust"> Trust this browser for 30 days</label>
<button class="btn" type="submit" id="open" hidden>Open the dashboard</button>
<button type="button" class="link" id="use-email" hidden>Can’t use your authenticator? Email me a code</button>
<button type="button" class="link" id="use-app" hidden>Use my authenticator app instead</button>
<p class="msg" role="status" id="code-msg"></p></form></div></div>

<div class="shell" id="shell" hidden>
<aside class="sidebar" id="sidebar">
<a class="side-brand" href="/">${LOGO.replaceAll("hk-gold", "hk-gold-side")}<span>HEARKEN</span><small>Admin</small></a>
<nav aria-label="Dashboard">${nav}</nav>
<div class="side-foot"><span class="me" id="me"></span><a href="/">Back to the website</a><button type="button" id="admin-out">Sign out</button></div>
</aside>
<div class="scrim" id="scrim"></div>
<div class="main">
<header class="topbar"><button class="burger" type="button" id="burger" aria-label="Menu" aria-controls="sidebar" aria-expanded="false"><span></span><span></span><span></span></button>
<h1 id="title">Overview</h1><span class="updated" id="updated"></span><button class="btn ghost small" type="button" id="refresh">Refresh</button></header>
<main id="views">
<section data-view="overview">
<div class="tiles" id="tiles"></div>
<div class="grid2"><div class="card"><h2>New accounts per week</h2><div class="bars" id="chart-accounts"></div></div>
<div class="card"><h2>Trials started per week</h2><div class="bars" id="chart-trials"></div></div></div>
<div class="grid2"><div class="card"><div class="card-head"><h2>Newest accounts</h2><a href="#accounts">All accounts →</a></div><div class="table"><table><tbody id="recent"></tbody></table></div></div>
<div class="card"><div class="card-head"><h2>App versions</h2></div><p class="hint">Computers by the version they first ran.</p><ul class="list" id="versions"></ul></div></div>
</section>
<section data-view="accounts" hidden>
<div class="toolbar"><label class="sr" for="q-accounts">Search accounts</label><input class="search" id="q-accounts" type="search" placeholder="Search church or email">
<div class="chips" id="chips"></div></div>
<div class="card flush"><div class="table"><table><thead><tr><th>Church</th><th>Email</th><th>Created</th><th>Computers</th><th>Last used</th><th>Status</th></tr></thead><tbody id="accounts"></tbody></table></div></div>
</section>
<section data-view="computers" hidden>
<div class="toolbar"><label class="sr" for="q-computers">Search computers</label><input class="search" id="q-computers" type="search" placeholder="Search computer or church"></div>
<div class="card flush"><div class="table"><table><thead><tr><th>Computer</th><th>Church</th><th>First signed in</th><th>Last used</th><th>Trial</th></tr></thead><tbody id="computers"></tbody></table></div></div>
</section>
<section data-view="trials" hidden>
<p class="hint">Every computer that has opened Hearken and gone online, signed in or not. A trial lasts 60 days from the first time Hearken opens.</p>
<div class="card flush"><div class="table"><table><thead><tr><th>Computer</th><th>Church</th><th>Version</th><th>Started</th><th>Ends</th></tr></thead><tbody id="trials"></tbody></table></div></div>
</section>
<section data-view="licences" hidden>
<p class="hint">To issue a licence, open the church from Accounts.</p>
<div class="card flush"><div class="table"><table><thead><tr><th>Church</th><th>Plan</th><th>Until</th><th>State</th></tr></thead><tbody id="licences"></tbody></table></div></div>
<div class="card"><h2>Activity</h2><ul class="list" id="log"></ul></div>
</section>
<section data-view="security" hidden>
<div class="card" id="totp-card"><h2>Authenticator app</h2><p id="totp-state"></p>
<div id="totp-setup" hidden>
<ol class="steps"><li>Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password…) and add an account by scanning this code.</li>
<li>Type the 6-digit code it shows, to confirm.</li></ol>
<div class="qr-row"><div class="qr" id="totp-qr" role="img" aria-label="QR code for your authenticator app"></div>
<div class="qr-side"><p class="hint">Can’t scan? Enter this key in the app instead:</p><code id="totp-secret"></code></div></div>
<form class="form inline" id="totp-confirm" novalidate><label class="sr" for="totp-code">Code from the app</label><input id="totp-code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code"><button class="btn" type="submit">Turn on</button></form></div>
<button class="btn" type="button" id="totp-begin" hidden>Set up an authenticator app</button>
<form class="form inline" id="totp-remove" hidden novalidate><label class="sr" for="totp-remove-code">Code from the app</label><input id="totp-remove-code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="Code from the app"><button class="btn ghost danger" type="submit">Remove it</button></form>
<p class="msg" role="status" id="totp-msg"></p></div>
<div class="card"><h2>Staying signed in</h2><p class="hint">Without “Trust this browser”, the dashboard asks again after 12 hours. Trusted browsers skip the second step for 30 days. Signing out here, or out of the account page, ends it straight away.</p></div>
</section>
</main></div></div>

<dialog id="detail" aria-labelledby="d-church"><div class="detail">
<header><div><h2 id="d-church"></h2><p class="hint" id="d-who"></p></div><button class="btn ghost small" type="button" id="d-close">Close</button></header>
<section><h3>Licence</h3><p id="d-licence"></p>
<form class="form issue" id="issue" novalidate>
<label for="i-plan">Plan</label><input id="i-plan" value="standard" maxlength="40">
<label for="i-length">Length</label><select id="i-length"><option value="m1">1 month</option><option value="m3">3 months</option><option value="m6">6 months</option><option value="m12" selected>12 months</option><option value="d14">14 days</option><option value="d30">30 days</option></select>
<label class="check"><input type="checkbox" id="i-send" checked> Email the key to the church</label>
<button class="btn" type="submit">Issue licence</button></form>
<button class="link danger" type="button" id="d-revoke">Revoke the licence</button>
<p class="hint">A licence already on a computer keeps working there until its end date: keys work offline, so revoking only stops it reaching more computers.</p></section>
<section><h3>Computers</h3><ul class="rows" id="d-computers"></ul></section>
<section><h3>Church name</h3><form class="form inline" id="d-rename" novalidate><label class="sr" for="d-name">Church name</label><input id="d-name" maxlength="120"><button class="btn ghost" type="submit">Save</button></form></section>
<section><h3>Sign-in</h3><div class="row"><button class="btn ghost small" type="button" id="d-reset">Send a password-reset email</button><button class="btn ghost small" type="button" id="d-signout">Sign out everywhere</button></div></section>
<section class="danger-zone" id="d-danger"><h3>Delete the account</h3><p class="hint">Removes the account, its licence and its computers’ sign-ins. Trials stay with their computers.</p>
<form class="form inline" id="d-delete" novalidate><label class="sr" for="d-confirm">Type the account’s email to confirm</label><input id="d-confirm" placeholder="Type the account’s email to confirm"><button class="btn ghost danger" type="submit">Delete</button></form></section>
<p class="msg" role="status" id="d-msg"></p></div></dialog>
<script src="/vendor/qrcode.js"></script>
<script src="/admin.js"></script>
</body></html>
`;
}

/** Where the "reset your password" email leads. */
function resetPage() {
  return page({
    title: "Reset your password · Hearken Studio",
    current: "",
    description: "Choose a new password for your Hearken Studio account.",
    body: `<div class="wrap narrow"><header class="head"><p class="eyebrow">Account</p><h1>Choose a new password.</h1>
<p class="lede">After this, every computer is signed out. Sign in again in the app, or on your <a href="/account">account page</a>, with your new password.</p></header>
<form class="reset" id="reset">
<label for="pw">New password</label><input id="pw" type="password" autocomplete="new-password" minlength="8" required>
<label for="pw2">Type it again</label><input id="pw2" type="password" autocomplete="new-password" minlength="8" required>
<button class="btn" type="submit">Save new password</button>
<p class="msg" role="status" id="msg"></p></form></div>
<script>
const form = document.getElementById("reset"), msg = document.getElementById("msg");
const token = new URLSearchParams(location.search).get("token");
if (!token) msg.textContent = "This link isn’t complete. Open it again from the email.";
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = form.pw.value;
  if (pw !== form.pw2.value) return (msg.textContent = "The two passwords don’t match.");
  msg.textContent = "Saving…";
  try {
    const res = await fetch("/api/auth/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password: pw }) });
    const body = await res.json();
    if (!res.ok) return (msg.textContent = body.error ?? "That didn’t work. Try again.");
    form.replaceChildren(Object.assign(document.createElement("p"), { className: "lede", textContent: "Your password has been changed. Sign in again in the app." }));
  } catch {
    msg.textContent = "Couldn’t reach the server. Check your connection and try again.";
  }
});
</script>`,
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
<a class="card" href="/manual"><h3>Read the manual →</h3><p>Every feature, step by step, with screenshots.</p></a>
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
  "manual.html": await manualPage(),
  "reset.html": resetPage(),
  "account.html": accountPage(),
  "admin.html": adminPage(),
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
