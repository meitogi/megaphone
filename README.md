# Megaphone

Write, preview, schedule and publish social posts on every network from one
static page and this Git repository. No database, no server, no paid API :
the repo is the queue, GitHub Actions is the scheduler, GitHub Pages hosts
the page.

Status : scheduling. The page lists, creates, edits and previews posts,
publishes one at once to Bluesky, Mastodon and Discord, sends one to Dev.to
through the Action, and opens the pre-filled composers of X, Threads,
LinkedIn, Facebook, Reddit and Hacker News with the image on the clipboard.
Every hour, the Action publishes the due `ready` posts. Threads, LinkedIn,
Facebook and Instagram by API arrive in a later version (their Publish
buttons are there, disabled).

## How it works

Each post is one Markdown file under `posts/`, named `YYYY-MM-DD-slug.md` :

```
---
date: 2026-11-03T09:00+01:00
networks: all
image: img/sandbox-dns.png
alt: Terminal showing dnsmasq answering REFUSED to an unlisted domain
tags: [ClaudeCode, devcontainer, infosec]
link: https://github.com/meitogi/devcontainer-sandbox
status: draft
---
Outbound DNS in Dev Sandbox answers REFUSED for anything not on the
allowlist. Not NXDOMAIN: REFUSED.

## long
Optional long variant for LinkedIn and Facebook.
```

`networks` is `all` (Bluesky, Mastodon, Threads, LinkedIn, Facebook,
Instagram, Discord) or a list ; `x` and `devto` are reached only when listed.
`title` serves Dev.to (required there), Reddit and Hacker News ; `sub` is the
subreddit. `status` goes `draft` →
`ready` → `published`. Unknown keys are kept as they are.

Per network, the text is adapted by [`lib/post.mjs`](lib/post.mjs), the same
module the page, the scripts and the tests import :

| Network | Text | Limit |
|---|---|---|
| Bluesky | body, link as a facet | 300 |
| Mastodon, Threads | body, link, `#tags` appended | 500 |
| LinkedIn, Facebook | `## long` else body, link removed | — |
| X | body | 280 |
| Instagram | body ; skipped without an image | — |
| Discord, Dev.to | body, untouched | — |

The preview warns on over-length, an image without `alt`, and the wording
guard-rails : PurrPause is never « hidden », « camouflaged » or « hard to
disable » ; a CTR post with a GIF or MP4 says « bring your own disc ».

## The four flows

1. **Claude writes** : drafts are generated in a Claude Code session, as
   files under `posts/`, and committed locally. Pushing is a human step.
2. **The page reviews** : open the page, edit, preview per network, mark a
   post `ready` with a date — or publish it at once to Bluesky, Mastodon and
   Discord, straight from the browser.
3. **The Action publishes** : every hour, the due `ready` posts go out to
   every automated network and move to `published/`. A failing network is
   noted in the file and retried the next hour.
4. **Pre-filled composers** : for X, Reddit and Hacker News (and Threads,
   LinkedIn, Facebook until their API arrives), a button copies the image to
   the clipboard and opens the network's composer already filled in. One
   paste, one click.

## Run it locally

```
npm install
npm run ui
```

Then open <http://localhost:4173> (VS Code forwards the port from a
devcontainer). The `local` backend reads and writes `posts/` on disk.
`PORT=8790 npm run ui` picks another port.

The page also works against GitHub : in Settings, choose the `github`
backend and give the owner, the repo and a fine-grained personal access
token limited to this repository (Contents : read and write ; Actions : read
and write for the Dev.to button). Settings live in the browser's
`localStorage` only. On GitHub Pages, with nothing saved yet, the page picks
the `github` backend and reads the owner and the repo from its own address. The repo is public : drafts are
public too, and no secret ever goes into a post.

## Publish now

Bluesky, Mastodon and Discord are called directly : from the browser by the
page's « Publish » button on each card, or from a terminal :

```
npm run publish -- posts/2026-11-03-sandbox-dns-refused.md
npm run publish -- posts/2026-11-03-sandbox-dns-refused.md --network mastodon
npm run publish -- posts/2026-11-03-sandbox-dns-refused.md --network discord --force
```

The text sent is exactly the preview's. Images are `posts/img/*.png`, `.jpg`,
`.jpeg`, `.gif` or `.webp` (2 MB at most on Bluesky) ; video is not uploaded
yet. Each network's result is written into the post's frontmatter, one key
per network :

```
bluesky: https://bsky.app/profile/meitogi.bsky.social/post/3l…
mastodon: failed 2026-11-03T09:00:12Z mastodon status : HTTP 401 The access token is invalid
```

A network that already holds a link is skipped (`--force`, or confirming in
the page, posts again). A failure never stops the other networks ; the
command exits 1 if any attempted network failed. `status` is left as it is.

The command reads `.env` (gitignored) at the root of this repository ; the
page keeps the same values in its Settings :

| Variable | Page setting | Value |
|---|---|---|
| `BLUESKY_HANDLE` | Bluesky handle | `meitogi.bsky.social` |
| `BLUESKY_APP_PASSWORD` | Bluesky app password | an app password, not the account password |
| `MASTODON_URL` | Mastodon instance URL | `https://fosstodon.org` |
| `MASTODON_TOKEN` | Mastodon token | scopes `write:statuses write:media read:accounts` |
| `DISCORD_WEBHOOK` | Discord webhook URL | the channel's webhook URL |
| `DEVTO_API_KEY` | — | Dev.to API key (DEV Settings → Extensions) ; CLI and Action only |

Dev.to is reached from the command line and from the Action only : its API
answers no CORS request, so the page's Dev.to button dispatches the Action
instead (below). The article is the post body as Markdown, `title` is
required, the first four `tags` go lower-cased to letters and digits, and
in the Action the cover is the post image on `raw.githubusercontent.com`.

## Schedule

A post is due when its `status` is `ready` and its `date` has passed (a
missing or unreadable date is never due ; the run says so). Every hour, at
minute 17, `.github/workflows/publish.yml` runs `npm run due`, which does
the same locally :

```
npm run due
```

For each due post, every network it targets among Bluesky, Mastodon,
Discord and Dev.to is published, exactly as `npm run publish` does. **When
all of them hold a success**, the post gets `status: published` and moves to
`published/` (same name ; images stay in `posts/img/`). Otherwise it stays
`ready` in `posts/` : the next hour retries the failed networks and skips
the ones already out. There is no retry limit — fix the cause (a secret, the
text) and the next run picks it up. X is manual (Compose in the page) ;
Threads, LinkedIn, Facebook and Instagram are not built yet and do not hold
a post back, so a post moved before they are will not get their copy.

The Action commits the results as `github-actions[bot]`, even when a network
failed. To run it now, or for one post and one network (no date check, no
move — the next hourly run moves it once complete) :

```
gh workflow run publish.yml
gh workflow run publish.yml -f post=2026-11-03-sandbox-dns-refused.md -f network=devto
```

The page's Dev.to button does the second one, with the PAT of its settings :
it needs the `github` backend and the post saved (the Action reads `main`).
Reload a minute later to see the result.

### Actions secrets

Settings → Secrets and variables → Actions, one per value the networks
need (a missing one fails only that network) :

| Secret | Value |
|---|---|
| `BLUESKY_HANDLE` | `meitogi.bsky.social` |
| `BLUESKY_APP_PASSWORD` | an app password |
| `MASTODON_URL` | `https://fosstodon.org` |
| `MASTODON_TOKEN` | scopes `write:statuses write:media read:accounts` |
| `DEVTO_API_KEY` | the Dev.to API key |
| `DISCORD_WEBHOOK` | the channel's webhook URL |

## Pre-filled composers

The X, Threads, LinkedIn and Facebook cards carry a « Compose » button ;
Reddit and Hacker News sit in the « Manual » row under the preview (they
need `title`, plus `sub` for Reddit, or `link` for Hacker News — a disabled
button says which is missing). One click copies the post image to the
clipboard as a PNG (other formats are converted) and opens the composer in a
popup docked on the right, reused from one network to the next. Paste the
image, check, post.

| Network | Prefilled | Copy |
|---|---|---|
| X | the text | the link, to post as a reply |
| Threads | the text, link and tags | — |
| LinkedIn | the long text and the link (when LinkedIn honours it) | the same text |
| Facebook | the link only | the text |
| Reddit | title and text | — |
| Hacker News | link and title | — |

Without an image, the text a composer does not receive goes to the
clipboard instead. A refused clipboard still opens the composer, and says
so.

## The page on GitHub Pages

`.github/workflows/pages.yml` deploys the page on every push to `main` that
touches `index.html`, `lib/` or the build. `scripts/site.mjs` copies `index.html` and
`lib/*.mjs` into `site/` and nothing else ; a symlink, a sub-directory or
any other file in `lib/` fails the build. Once, on GitHub : Settings → Pages
→ Source : « GitHub Actions ». The page is then at
`https://<owner>.github.io/megaphone/`.

## Scripts

| Script | Does |
|---|---|
| `npm run ui` | the page and the local backend on `localhost:4173` |
| `npm test` | `node --test` on the post logic, the backends, the publishing requests, the schedule, the site build and the workflows |
| `npm run publish -- posts/<file>.md` | publish one post now to Bluesky, Mastodon, Discord, Dev.to (`--network`, `--force`) |
| `npm run due` | publish every due `ready` post, move the complete ones to `published/` |
| `node scripts/site.mjs` | build `site/` for GitHub Pages |
| `npm run brand` | `assets/avatar-400.png`, `avatar-1024.png`, `banner-1500x500.png` from the SVGs in `assets/` (needs DejaVu Sans, as in `fonts-dejavu-core`) |
| `npm run card`, `review`, `linkedin:auth` | not built yet ; they exit 1 |

## Layout

```
index.html        the page : settings, list, editor, per-network preview
lib/post.mjs      parse, serialize, render per network, due and completion rules, intents
lib/publish.mjs   Bluesky, Mastodon, Discord, Dev.to requests, shared by page and CLI
lib/backends.mjs  local and GitHub backends : list, read, write, remove, bytes ; dispatch
scripts/ui.mjs    the local server
scripts/publish.mjs  npm run publish
scripts/due.mjs   npm run due
scripts/site.mjs  the Pages build
scripts/brand.mjs profile images
.github/workflows publish.yml (hourly + dispatch), pages.yml
posts/            the queue ; posts/img/ for images
published/        posts already out
ideas.md          one line per post idea
metrics.md        one line per month
assets/           brand sources and renders
```

## Publishing this repository

Once the empty `meitogi/megaphone` repository exists on GitHub, from this
directory on the host (the last line confirms `main` tracks `origin/main`) :

```
git remote add origin git@github.com:meitogi/megaphone.git
git push -u origin main
git status -sb
```

Then, on GitHub : the Actions secrets above, Settings → Pages → Source
« GitHub Actions », and a fine-grained PAT for the page (Contents and
Actions, read and write, this repository only).

## License

MIT, see [LICENSE](LICENSE).
