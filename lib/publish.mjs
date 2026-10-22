// Publishing to the networks the browser can reach directly (Bluesky, Mastodon,
// Discord) and to Dev.to, which only the CLI and the Action reach (no CORS on its
// POST). Shared by the page, `npm run publish` and `npm run due`.
// fetch, FormData, Blob and TextEncoder only : no Node API, no DOM.
import { render, facets } from './post.mjs';

export const DIRECT = ['bluesky', 'mastodon', 'discord'];
// What the CLI and the Action publish today ; a post is complete when all of its
// networks in this list hold a success.
export const ACTION = [...DIRECT, 'devto'];

// The settings each network needs, as named in the page's localStorage.
export const SETTINGS = {
  bluesky: { bskyHandle: 'Bluesky handle', bskyPassword: 'Bluesky app password' },
  mastodon: { mastoUrl: 'Mastodon instance URL', mastoToken: 'Mastodon token' },
  discord: { discordWebhook: 'Discord webhook URL' },
  devto: { devtoKey: 'Dev.to API key' },
};

// app.bsky.embed.images `maxSize`, per the lexicon shipped in @atproto/api 0.29.1.
export const BSKY_MAX_BYTES = 2000000;
const BSKY = 'https://bsky.social/xrpc';
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// The labels of the settings `network` still lacks ; empty when it can publish.
export function missing(network, creds) {
  const out = [];
  const need = SETTINGS[network];
  for (const k in need) if (!creds[k]) out.push(need[k]);
  return out;
}

// `meta.image` (`img/<name>`, relative to posts/) → { bytes, type, alt, name }, or
// null without an image. `bytes(path)` is the caller's reader : disk or backend.
export async function loadImage(post, bytes) {
  const { image, alt } = post.meta;
  if (!image) return null;
  const m = /^img\/([\w-][\w.-]*)\.(\w+)$/.exec(image);
  if (!m) throw new Error(`image ${image} : expected img/<name>.png|jpg|jpeg|gif|webp`);
  const ext = m[2].toLowerCase();
  if (ext === 'mp4') throw new Error('video upload is not supported yet : images only');
  if (!TYPES[ext]) throw new Error(`image ${image} : expected .png, .jpg, .jpeg, .gif or .webp`);
  return { bytes: await bytes(image), type: TYPES[ext], alt: alt || '', name: `${m[1]}.${m[2]}` };
}

// The HTTP error as one line, from the response body only : never the URL or a header.
async function call(f, what, url, init) {
  const res = await f(url, init);
  if (res.ok) return res;
  const raw = await res.text().catch(() => '');
  let msg = raw;
  try {
    const j = JSON.parse(raw);
    msg = j.message || j.error_description || j.error || raw;
  } catch {}
  throw new Error(`${what} : HTTP ${res.status} ${String(msg).slice(0, 200)}`.trim());
}

async function bluesky(text, { creds, image, f }) {
  if (image && image.bytes.length > BSKY_MAX_BYTES) {
    throw new Error(`bluesky : image is ${image.bytes.length} bytes, the limit is ${BSKY_MAX_BYTES}`);
  }
  const json = { 'Content-Type': 'application/json' };
  const session = await call(f, 'bluesky session', `${BSKY}/com.atproto.server.createSession`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ identifier: creds.bskyHandle, password: creds.bskyPassword }),
  });
  const { accessJwt, did, handle } = await session.json();
  const auth = { Authorization: `Bearer ${accessJwt}` };
  const record = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString() };
  const links = facets(text);
  if (links.length) record.facets = links;
  if (image) {
    const up = await call(f, 'bluesky upload', `${BSKY}/com.atproto.repo.uploadBlob`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': image.type },
      body: image.bytes,
    });
    const { blob } = await up.json();
    record.embed = { $type: 'app.bsky.embed.images', images: [{ image: blob, alt: image.alt }] };
  }
  const res = await call(f, 'bluesky post', `${BSKY}/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: { ...auth, ...json },
    body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
  });
  const { uri } = await res.json();
  return { url: `https://bsky.app/profile/${handle || creds.bskyHandle}/post/${uri.split('/').pop()}` };
}

async function mastodon(text, { creds, image, f, name, sleep }) {
  const base = creds.mastoUrl.replace(/\/+$/, '');
  const auth = { Authorization: `Bearer ${creds.mastoToken}` };
  const mediaIds = [];
  if (image) {
    const form = new FormData();
    form.append('file', new Blob([image.bytes], { type: image.type }), image.name);
    if (image.alt) form.append('description', image.alt);
    let media = await (await call(f, 'mastodon media', `${base}/api/v2/media`, { method: 'POST', headers: auth, body: form })).json();
    // 202 : still processing, `url` is null until it is done.
    for (let i = 0; !media.url; i++) {
      if (i === 10) throw new Error('mastodon media : still processing after 10 tries');
      await sleep(1000);
      media = await (await call(f, 'mastodon media', `${base}/api/v1/media/${media.id}`, { headers: auth })).json();
    }
    mediaIds.push(media.id);
  }
  const res = await call(f, 'mastodon status', `${base}/api/v1/statuses`, {
    method: 'POST',
    // Same key on a retry : Mastodon returns the status it already made.
    headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': `megaphone-${name}-mastodon` },
    body: JSON.stringify({ status: text, media_ids: mediaIds }),
  });
  return { url: (await res.json()).url };
}

async function discord(text, { creds, image, f }) {
  const payload = { content: text };
  const form = new FormData();
  if (image) {
    payload.attachments = [{ id: 0, filename: image.name, description: image.alt }];
    form.append('files[0]', new Blob([image.bytes], { type: image.type }), image.name);
  }
  form.append('payload_json', JSON.stringify(payload));
  const hook = creds.discordWebhook;
  const res = await call(f, 'discord', `${hook}${hook.includes('?') ? '&' : '?'}wait=true`, { method: 'POST', body: form });
  const m = await res.json();
  return { url: m.guild_id ? `https://discord.com/channels/${m.guild_id}/${m.channel_id}/${m.id}` : `ok ${m.id}` };
}

// Dev.to tags : at most 4, lower-case letters and digits only.
export function devtoTags(tags) {
  const out = [];
  for (const t of Array.isArray(tags) ? tags : tags ? [tags] : []) {
    const tag = String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (tag && !out.includes(tag) && out.length < 4) out.push(tag);
  }
  return out;
}

// POST /api/articles of the Forem API v1 (developers.forem.com). The cover is the
// post image on raw.githubusercontent.com, so only when the repository is known.
async function devto(text, { creds, post, f, repository }) {
  const { title, image, tags } = post.meta;
  if (!title) throw new Error('devto : needs a title');
  const article = { title, body_markdown: text, published: true };
  const list = devtoTags(tags);
  if (list.length) article.tags = list.join(',');
  if (repository && image) article.main_image = `https://raw.githubusercontent.com/${repository}/main/posts/${image}`;
  const res = await call(f, 'devto', 'https://dev.to/api/articles', {
    method: 'POST',
    headers: { 'api-key': creds.devtoKey, Accept: 'application/vnd.forem.api-v1+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ article }),
  });
  return { url: (await res.json()).url };
}

const SENDERS = { bluesky, mastodon, discord, devto };

// Sends `render(post, network).text` — exactly what the preview shows.
// `image` comes from `loadImage` ; `name` (the post file name) keys Mastodon's
// idempotency ; `repository` (`owner/repo`) gives Dev.to its cover URL. Resolves to
// { url } (a URL, or `ok <id>`), throws otherwise.
export async function publish(post, network, { creds, image = null, name, repository, fetch: f = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const send = SENDERS[network];
  if (!send) throw new Error(`${network} : not a network publish() reaches`);
  const lacks = missing(network, creds);
  if (lacks.length) throw new Error(`${network} : missing ${lacks.join(', ')}`);
  const { text, count, limit, skipped } = render(post, network);
  if (skipped || !text.trim()) throw new Error(`${network} : nothing to publish`);
  if (limit && count > limit) throw new Error(`${network} : ${count} / ${limit} characters`);
  return send(text, { creds, image, f, name, sleep, post, repository });
}
