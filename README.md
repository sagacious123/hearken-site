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

## Trial and licences

The app's free trial and licence keys are passes signed with an Ed25519 key. The app checks them offline with the matching public key, in `src-tauri/src/licence/token.rs` in the app repo.

| Endpoint | Does |
|---|---|
| `POST /api/trial` | Registers a computer's trial the first time it's online, by an anonymous ID the app makes, and signs its dates. A reinstall on the same computer gets the dates first registered. |
| `GET /api/time?nonce=…` | The website's clock, signed, so the app can tell a wrong date from one turned back. |
| `POST /api/auth/signup`, `/login` | Creates the church's account or signs in on a computer: returns a session, a signed sign-in pass valid offline for 30 days, and the account's licence. |
| `POST /api/auth/refresh` | Renews the sign-in pass and fetches the licence (the app does this whenever it's online). |
| `POST /api/auth/logout` | Ends a computer's session. |
| `POST /api/auth/forgot`, `/reset` | Emails a link to `/reset` (valid an hour); a new password signs every computer out. |

Passwords are hashed with scrypt; sessions are stored only as hashes; sign-in and reset attempts are rate-limited.

What they need on Vercel:

- **`LICENCE_SIGNING_KEY`**: the private key (PKCS#8 PEM), as a sensitive environment variable. The original is in `~/.hearken/licence-signing-key.pem` on the computer that created it. **Back it up in a password manager.** If it's lost, keys can't be issued for the apps already installed. If it leaks, anyone can make licence keys.
- **`MAILER_SECRET_KEY`**: one of the backend keys (`MAILER_SECRET_KEYS`) of Hearken's mailer, [hearken-mailer](https://hearken-mailer.vercel.app), which sends the password-reset emails over SMTP with its branded template. `MAILER_URL` points at another copy of it (default `https://hearken-mailer.vercel.app/api/send`). Without the key, "Forgot your password?" answers that the service isn't available.
- **Upstash Redis** from the Storage tab (it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`), to remember accounts, sessions and each computer's trial. **Sign-in doesn't work without it**, and `/api/trial` answers 503 (the app keeps its offline trial).

### Issuing a licence by hand

Until payments issue keys automatically:

```bash
npm run licence -- --church "Grace Chapel" --months 12
```

This prints the key to email to the church and records it in `~/.hearken/licences.jsonl`. Add `--email media@grace.org` to attach it to that church's account, so the app picks it up by itself. That needs the database's `KV_REST_API_URL` and `KV_REST_API_TOKEN` in `.env.local` (git-ignored), copied from the Upstash console. Vercel stores them as sensitive, so `vercel env pull` can't fetch them.

`npm test` runs the endpoint tests. `node scripts/local-api.mjs` runs the API on this computer with an in-memory store, for testing the app against it (`HEARKEN_API=http://localhost:4400/api`).

## Deploying

The site deploys from `main` on Vercel. The settings are in `vercel.json`: build with `node build.mjs`, serve `dist/`, and use clean URLs (`/blog` rather than `/blog.html`).
