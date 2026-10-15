# Hearken Studio website

The site for [Hearken Studio](https://github.com/Sagacious123/hearken-studio): the landing page, guides, support and changelog. It's plain HTML and CSS built by one Node script with no dependencies, and hosted on Vercel.

## Working on it

```bash
npm run dev            # build, then serve at http://localhost:4321
npm run build          # build into dist/
npm run build:offline  # build without contacting GitHub
```

Node 18 or newer is needed.

## What's where

| To change | Edit |
|---|---|
| The landing page | `src/index.html` |
| Styles for the other pages | `src/site.css` |
| Blog guides | `content/guides.json` (title, category, read time, summary and HTML body) |
| Support questions | `content/faq.json` |
| "Coming next" on the changelog | `content/upcoming.md` (set `version:` to the next release; it disappears once that version is published) |
| Notes for a past release | `content/changelog/<version>.md` (overrides the notes on GitHub) |
| Page template, nav and footer | `build.mjs` |

Images and other files in `src/` are copied to the site as they are.

## Releases, downloads and the changelog

Each build reads the published releases of the app from GitHub:

- **Download buttons** on the landing page link to the latest release's files, with their sizes. In `src/index.html` they're written as `{{url:mac-arm}}`, `{{size:mac-arm}}` and `{{version}}`. The files each button picks are listed in `DOWNLOADS` in `build.mjs`.
- **The changelog** shows each release's notes from GitHub, written in Markdown. The `### Installing` section is left out.

If GitHub can't be reached, the build uses `content/releases.json`, the copy saved by the last successful build. Commit that file now and then so it stays recent.

### Updating the site when a release is published

The app repo's `site-refresh.yml` workflow calls a Vercel deploy hook whenever a release is published, so new downloads and notes go live within a minute or two. To set it up:

1. In Vercel, open the project → **Settings → Git → Deploy Hooks**, create a hook for the `main` branch and copy its URL.
2. In the app repo on GitHub, open **Settings → Secrets and variables → Actions** and add a secret named `VERCEL_DEPLOY_HOOK` with that URL.

## Deploying

The site deploys from `main` on Vercel. The settings are in `vercel.json`: build with `node build.mjs`, serve `dist/`, and use clean URLs (`/blog` rather than `/blog.html`).
