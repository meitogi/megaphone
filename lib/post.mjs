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
