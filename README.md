# Megaphone

Write, preview, schedule and publish social posts on every network from one
static page and this Git repository. No database, no server, no paid API :
the repo is the queue, GitHub Actions is the scheduler, GitHub Pages hosts
the page.

Status : scaffold. The page lists, creates, edits and previews posts ;
publishing arrives in later versions (the buttons are there, disabled).

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
`title` and `sub` serve Reddit and Hacker News. `status` goes `draft` →
`ready` → `published`. Unknown keys are kept as they are.

Per network, the text is adapted by [`lib/post.mjs`](lib/post.mjs), the same
module the page, the scripts and the tests import :

| Network | Text | Limit |
|---|---|---|
| Bluesky | body, link kept in the text | 300 |
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
4. **Pre-filled composers** : for X, Reddit and Hacker News, a button copies
   the image to the clipboard and opens the network's composer already
   filled in. One paste, one click.

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
token limited to this repository (Contents : read and write). Settings live
in the browser's `localStorage` only. The repo is public : drafts are
public too, and no secret ever goes into a post.

## Scripts

| Script | Does |
|---|---|
| `npm run ui` | the page and the local backend on `localhost:4173` |
| `npm test` | `node --test` on the post logic and the backends |
| `npm run brand` | `assets/avatar-400.png`, `avatar-1024.png`, `banner-1500x500.png` from the SVGs in `assets/` (needs DejaVu Sans, as in `fonts-dejavu-core`) |
| `npm run card`, `publish`, `due`, `review`, `linkedin:auth` | not built yet ; they exit 1 |

## Layout

```
index.html        the page : settings, list, editor, per-network preview
lib/post.mjs      parse, serialize, render per network, slug
lib/backends.mjs  local and GitHub backends : list, read, write, remove
scripts/ui.mjs    the local server
scripts/brand.mjs profile images
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

## License

MIT, see [LICENSE](LICENSE).
