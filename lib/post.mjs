// Pure post logic, shared by the page, the scripts and the tests.
// No dependency, no DOM, no Node API.

// What `networks: all` expands to : the networks the Action publishes to.
// X and Dev.to are reached only when a post lists them by name.
export const AUTOMATED = ['bluesky', 'mastodon', 'threads', 'linkedin', 'facebook', 'instagram', 'discord'];
export const NETWORKS = [...AUTOMATED, 'devto', 'x'];
export const STATUSES = ['draft', 'ready', 'published'];

const LIMITS = { bluesky: 300, mastodon: 500, threads: 500, x: 280 };
const LIST_KEYS = ['networks', 'tags'];
const PURRPAUSE_WORDS = ['hidden', 'camouflaged', 'hard to disable'];

// --- format ---------------------------------------------------------------

// `---` frontmatter of `key: value` lines, `[a, b]` lists for LIST_KEYS, then the body,
// then an optional `## long` section. Unknown keys are kept as strings.
export function parse(text) {
  const src = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  const meta = {};
  if (!m) return { meta, body: src.trim(), long: null };
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    const list = LIST_KEYS.includes(key) && /^\[(.*)\]$/.exec(raw);
    meta[key] = list ? list[1].split(',').map((s) => s.trim()).filter(Boolean) : raw;
  }
  const rest = m[2];
  const at = rest.search(/^## long[ \t]*$/m);
  if (at < 0) return { meta, body: rest.trim(), long: null };
  return { meta, body: rest.slice(0, at).trim(), long: rest.slice(at).replace(/^## long[ \t]*\n?/, '').trim() };
}

export function serialize(post) {
  const { meta, body, long } = post;
  const lines = [];
  for (const key in meta) {
    const v = meta[key];
    if (v == null) continue;
    lines.push(`${key}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`);
  }
  let out = `---\n${lines.join('\n')}\n---\n${(body || '').trim()}\n`;
  if (long != null && long.trim() !== '') out += `\n## long\n${long.trim()}\n`;
  return out;
}

export function expandNetworks(networks) {
  if (networks == null || networks === 'all') return AUTOMATED.slice();
  const list = Array.isArray(networks) ? networks : [networks];
  return list.includes('all') ? AUTOMATED.slice() : list;
}

export function slug(date, title) {
  const day = String(date || '').slice(0, 10);
  const words = String(title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${day}-${words || 'post'}.md`;
}

// --- per-network rendering -------------------------------------------------

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter() : null;

// Bluesky's limit is in graphemes ; the others are close enough to it.
export function count(text) {
  if (!segmenter) return [...text].length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

// The link as a whole word : `https://a/post` does not match inside `https://a/post-2`.
function linkRe(link) {
  const esc = link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${esc}(?=[.,;:!?)]*(\\s|$))`, 'g');
}

function withLink(text, link) {
  return link && !linkRe(link).test(text) ? `${text}\n\n${link}` : text;
}

function stripLink(text, link) {
  if (!link) return text;
  return text.replace(linkRe(link), '$1').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function hashtags(tags) {
  const list = Array.isArray(tags) ? tags : tags ? [tags] : [];
  return list.map((t) => `#${String(t).replace(/^#/, '')}`).join(' ');
}

export function render(post, network) {
  const { meta, body = '', long } = post;
  const link = meta.link;
  const tags = hashtags(meta.tags);
  const warnings = [];
  let text;
  let skipped = false;

  switch (network) {
    case 'bluesky':
    case 'reddit':
      // The link stays in the text ; `facets()` makes it clickable at publish time.
      text = withLink(body, link);
      break;
    case 'mastodon':
    case 'threads':
      text = withLink(body, link);
      if (tags) text = `${text}\n\n${tags}`;
      break;
    case 'linkedin':
    case 'facebook':
      text = stripLink(long && long.trim() ? long : body, link);
      break;
    case 'instagram':
      text = body;
      if (!meta.image) {
        skipped = true;
        warnings.push('instagram : no image, skipped');
      }
      break;
    default:
      text = body;
  }

  const limit = LIMITS[network] || null;
  const n = count(text);
  if (limit && n > limit) warnings.push(`${network} : ${n} / ${limit} characters`);
  if (meta.image && !meta.alt) warnings.push('image without alt text');

  // The product is named in the text, the tags or the title.
  const lower = text.toLowerCase();
  const about = `${lower} ${tags} ${meta.title || ''}`.toLowerCase();
  if (/purrpause/.test(about)) {
    for (const w of PURRPAUSE_WORDS) {
      if (lower.includes(w)) warnings.push(`PurrPause : never « ${w} »`);
    }
  }
  if (/\.(gif|mp4)$/i.test(meta.image || '') && /\bctr\b|crash team racing/.test(about) && !lower.includes('bring your own')) {
    warnings.push('CTR gameplay media : say « bring your own NTSC-U disc, nothing is hosted »');
  }

  return { text, warnings, count: n, limit, skipped };
}

// --- Bluesky link facets ----------------------------------------------------

const encoder = new TextEncoder();

// One `app.bsky.richtext.facet` per http(s) URL, trailing punctuation left out.
// Offsets are UTF-8 bytes, as the lexicon requires, not string indices.
export function facets(text) {
  const out = [];
  for (const m of text.matchAll(/https?:\/\/\S+/g)) {
    const uri = m[0].replace(/[.,;:!?)]+$/, '');
    const byteStart = encoder.encode(text.slice(0, m.index)).length;
    out.push({
      index: { byteStart, byteEnd: byteStart + encoder.encode(uri).length },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri }],
    });
  }
  return out;
}

// --- publish results ----------------------------------------------------------

// The result of a network, if it already went out : a URL, or `ok <id>`.
export function posted(post, network) {
  const v = post.meta[network];
  return typeof v === 'string' && /^(https?:\/\/|ok )/.test(v) ? v : null;
}

// One frontmatter key per network : the post URL, or `failed <ISO time> <message>`.
// The message is one line, URLs and the given secrets redacted (a Discord webhook
// URL carries its token), the whole value kept around 120 characters.
export function record(post, network, result, secrets = []) {
  if (result.url) {
    post.meta[network] = result.url;
    return post;
  }
  let msg = String(result.error || 'unknown error').replace(/https?:\/\/\S+/g, '<url>');
  for (const s of secrets) if (s) msg = msg.split(s).join('***');
  msg = msg.replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/\s+/g, ' ').trim();
  const at = (result.at || new Date()).toISOString().slice(0, 19) + 'Z';
  const line = `failed ${at} ${msg}`;
  post.meta[network] = line.length > 120 ? `${line.slice(0, 119)}…` : line;
  return post;
}

// --- schedule -------------------------------------------------------------------

// Why `post` is not due at `now` (ms), or null when it is : `ready` with a parseable
// `date` at or before now.
export function notDue(post, now) {
  const { status, date } = post.meta;
  if (status !== 'ready') return `status ${status || 'unset'}`;
  if (!date) return 'no date';
  const t = Date.parse(date);
  if (Number.isNaN(t)) return `unparseable date ${date}`;
  return t > now ? `due ${date}` : null;
}

// The networks of `post` that `able` can publish and that hold no success yet.
// Empty : the post is complete and moves to published/.
export function pending(post, able) {
  return expandNetworks(post.meta.networks).filter((n) => able.includes(n) && !posted(post, n));
}

// --- pre-filled composers ---------------------------------------------------------

export const INTENTS = ['x', 'threads', 'linkedin', 'facebook', 'reddit', 'hn'];

const q = (params) => new URLSearchParams(params).toString();

// The composer URL of `target`, prefilled from `post` : { url, copy? }, or { blocked }.
// `copy` is the text the URL does not carry, for the page to offer as a copy.
export function intent(post, target) {
  const { meta } = post;
  const { title, link } = meta;
  const text = render(post, target).text;
  switch (target) {
    case 'x':
      // The link goes in a reply : a link in the post itself costs reach.
      if (!text.trim()) return { blocked: 'No text' };
      return { url: `https://x.com/intent/post?${q({ text })}`, ...(link ? { copy: link } : {}) };
    case 'threads':
      if (!text.trim()) return { blocked: 'No text' };
      return { url: `https://www.threads.com/intent/post?${q({ text })}` };
    case 'linkedin': {
      // Undocumented and not always honoured : the text is offered as a copy too.
      const full = withLink(text, link);
      if (!full.trim()) return { blocked: 'No text' };
      return { url: `https://www.linkedin.com/feed/?${q({ shareActive: 'true', text: full })}`, copy: full };
    }
    case 'facebook':
      // The sharer takes the link only ; the text is pasted.
      if (!link) return { blocked: 'Needs a link' };
      return { url: `https://www.facebook.com/sharer/sharer.php?${q({ u: link })}`, ...(text.trim() ? { copy: text } : {}) };
    case 'reddit': {
      const sub = String(meta.sub || '').replace(/^\/?r\//, '');
      if (!title) return { blocked: 'Needs a title' };
      if (!sub) return { blocked: 'Needs a subreddit' };
      return { url: `https://www.reddit.com/r/${encodeURIComponent(sub)}/submit?${q({ title, selftext: 'true', text })}` };
    }
    case 'hn':
      if (!link) return { blocked: 'Needs a link' };
      if (!title) return { blocked: 'Needs a title' };
      return { url: `https://news.ycombinator.com/submitlink?${q({ u: link, t: title })}` };
    default:
      return { blocked: `${target} : no composer` };
  }
}
