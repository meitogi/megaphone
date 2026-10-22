import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, serialize, facets, record, posted } from '../lib/post.mjs';
import { publish, loadImage, missing, devtoTags, ACTION, BSKY_MAX_BYTES } from '../lib/publish.mjs';
import { run, creds } from '../scripts/publish.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- facets -------------------------------------------------------------------

function checkFacets(text, uris) {
  const got = facets(text);
  const bytes = enc.encode(text);
  assert.deepEqual(got.map((f) => f.features[0].uri), uris);
  for (const f of got) {
    assert.equal(f.features[0].$type, 'app.bsky.richtext.facet#link');
    assert.equal(dec.decode(bytes.slice(f.index.byteStart, f.index.byteEnd)), f.features[0].uri);
  }
  return got.map((f) => [f.index.byteStart, f.index.byteEnd]);
}

test('facets : byte offsets on ASCII', () => {
  assert.deepEqual(checkFacets('See https://a.io/x now', ['https://a.io/x']), [[4, 18]]);
});

test('facets : accents count two bytes', () => {
  // « Réglé » : é is 2 bytes, so 7 bytes for 5 characters, + the space.
  assert.deepEqual(checkFacets('Réglé https://a.io', ['https://a.io']), [[8, 20]]);
});

test('facets : an emoji counts four bytes, a ZWJ sequence all of its parts', () => {
  assert.deepEqual(checkFacets('🐈 https://a.io', ['https://a.io']), [[5, 17]]);
  // 🐈‍⬛ = U+1F408 (4) + ZWJ (3) + U+2B1B (3) = 10 bytes, one grapheme.
  assert.deepEqual(checkFacets('🐈‍⬛ http://b.io/p', ['http://b.io/p']), [[11, 24]]);
});

test('facets : two links, a link at the very end, trailing punctuation left out', () => {
  assert.deepEqual(
    checkFacets('One https://a.io/1, two (https://b.io/2). End https://c.io/3?!', ['https://a.io/1', 'https://b.io/2', 'https://c.io/3']),
    [[4, 18], [25, 39], [46, 60]],
  );
  assert.deepEqual(checkFacets('Last: https://a.io/end', ['https://a.io/end']), [[6, 22]]);
  assert.deepEqual(facets('no link here'), []);
});

// --- a fetch double no richer than fetch ----------------------------------------

// `routes(request, calls)` returns the Response ; every call is kept as a Request
// clone so the tests read what would really go on the wire.
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    const req = new Request(url, init);
    calls.push(req.clone());
    return routes(req, calls);
  };
  return { f, calls };
}

const CREDS = {
  bskyHandle: 'meitogi.bsky.social',
  bskyPassword: 'app-pass-1234',
  mastoUrl: 'https://fosstodon.org/',
  mastoToken: 'masto-tok',
  discordWebhook: 'https://discord.com/api/webhooks/42/hook-secret-token',
};
const IMAGE = { bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]), type: 'image/png', alt: 'A cat on a keyboard', name: 'cat.png' };
const post = () => ({
  meta: { networks: ['bluesky', 'mastodon', 'discord'], link: 'https://github.com/meitogi/megaphone', tags: ['oss'], image: 'img/cat.png', alt: 'A cat on a keyboard' },
  body: 'Megaphone ships — é 🐈',
  long: null,
});

function bskyRoutes(req) {
  const u = new URL(req.url);
  if (u.pathname.endsWith('createSession')) return Response.json({ accessJwt: 'jwt-1', did: 'did:plc:abc', handle: 'meitogi.bsky.social' });
  if (u.pathname.endsWith('uploadBlob')) return Response.json({ blob: { $type: 'blob', ref: { $link: 'bafkblob' }, mimeType: 'image/png', size: 7 } });
  if (u.pathname.endsWith('createRecord')) return Response.json({ uri: 'at://did:plc:abc/app.bsky.feed.post/3kxyz', cid: 'c' });
  return new Response('?', { status: 500 });
}

test('bluesky : session, blob upload, record with text, facets, blob ref and alt', async () => {
  const { f, calls } = fakeFetch(bskyRoutes);
  const { url } = await publish(post(), 'bluesky', { creds: CREDS, image: IMAGE, fetch: f });
  assert.equal(url, 'https://bsky.app/profile/meitogi.bsky.social/post/3kxyz');
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ['POST', 'https://bsky.social/xrpc/com.atproto.server.createSession'],
    ['POST', 'https://bsky.social/xrpc/com.atproto.repo.uploadBlob'],
    ['POST', 'https://bsky.social/xrpc/com.atproto.repo.createRecord'],
  ]);
  const [session, upload, create] = calls;
  assert.deepEqual(await session.json(), { identifier: 'meitogi.bsky.social', password: 'app-pass-1234' });
  assert.equal(session.headers.get('content-type'), 'application/json');
  assert.equal(upload.headers.get('authorization'), 'Bearer jwt-1');
  assert.equal(upload.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await upload.arrayBuffer()), IMAGE.bytes);
  assert.equal(create.headers.get('authorization'), 'Bearer jwt-1');
  const body = await create.json();
  assert.equal(body.repo, 'did:plc:abc');
  assert.equal(body.collection, 'app.bsky.feed.post');
  const text = 'Megaphone ships — é 🐈\n\nhttps://github.com/meitogi/megaphone';
  assert.equal(body.record.text, text);
  assert.equal(body.record.$type, 'app.bsky.feed.post');
  assert.ok(!Number.isNaN(Date.parse(body.record.createdAt)));
  assert.deepEqual(body.record.facets, facets(text));
  assert.equal(dec.decode(enc.encode(text).slice(body.record.facets[0].index.byteStart, body.record.facets[0].index.byteEnd)), 'https://github.com/meitogi/megaphone');
  assert.deepEqual(body.record.embed, {
    $type: 'app.bsky.embed.images',
    images: [{ image: { $type: 'blob', ref: { $link: 'bafkblob' }, mimeType: 'image/png', size: 7 }, alt: 'A cat on a keyboard' }],
  });
});

test('bluesky : an image over the lexicon maxSize is refused before any call', async () => {
  const { f, calls } = fakeFetch(bskyRoutes);
  const big = { ...IMAGE, bytes: new Uint8Array(BSKY_MAX_BYTES + 1) };
  await assert.rejects(publish(post(), 'bluesky', { creds: CREDS, image: big, fetch: f }), /2000001 bytes, the limit is 2000000/);
  assert.equal(calls.length, 0);
});

test('mastodon : media with alt, polled while processing, status with media id and idempotency key', async () => {
  let polls = 0;
  const { f, calls } = fakeFetch((req) => {
    const u = new URL(req.url);
    if (u.pathname === '/api/v2/media') return Response.json({ id: 'm1', url: null }, { status: 202 });
    if (u.pathname === '/api/v1/media/m1') return ++polls < 2 ? Response.json({ id: 'm1', url: null }, { status: 206 }) : Response.json({ id: 'm1', url: 'https://cdn/m1.png' });
    if (u.pathname === '/api/v1/statuses') return Response.json({ id: 's1', url: 'https://fosstodon.org/@meitogi/111' });
    return new Response('?', { status: 500 });
  });
  const { url } = await publish(post(), 'mastodon', { creds: CREDS, image: IMAGE, name: '2026-11-03-ship.md', fetch: f, sleep: async () => {} });
  assert.equal(url, 'https://fosstodon.org/@meitogi/111');
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ['POST', 'https://fosstodon.org/api/v2/media'],
    ['GET', 'https://fosstodon.org/api/v1/media/m1'],
    ['GET', 'https://fosstodon.org/api/v1/media/m1'],
    ['POST', 'https://fosstodon.org/api/v1/statuses'],
  ]);
  for (const c of calls) assert.equal(c.headers.get('authorization'), 'Bearer masto-tok');
  assert.match(calls[0].headers.get('content-type'), /^multipart\/form-data/);
  const form = await calls[0].formData();
  assert.equal(form.get('description'), 'A cat on a keyboard');
  assert.equal(form.get('file').name, 'cat.png');
  assert.equal(form.get('file').type, 'image/png');
  assert.deepEqual(new Uint8Array(await form.get('file').arrayBuffer()), IMAGE.bytes);
  const status = calls[3];
  assert.equal(status.headers.get('idempotency-key'), 'megaphone-2026-11-03-ship.md-mastodon');
  assert.equal(status.headers.get('content-type'), 'application/json');
  assert.deepEqual(await status.json(), {
    status: 'Megaphone ships — é 🐈\n\nhttps://github.com/meitogi/megaphone\n\n#oss',
    media_ids: ['m1'],
  });
});

test('mastodon : gives up when the media never finishes', async () => {
  const { f } = fakeFetch(() => Response.json({ id: 'm1', url: null }, { status: 202 }));
  await assert.rejects(publish(post(), 'mastodon', { creds: CREDS, image: IMAGE, name: 'a.md', fetch: f, sleep: async () => {} }), /still processing/);
});

test('discord : webhook with wait=true, payload_json with alt, the file part, a channel link', async () => {
  const { f, calls } = fakeFetch(() => Response.json({ id: '900', channel_id: '800', guild_id: '700' }));
  const { url } = await publish(post(), 'discord', { creds: CREDS, image: IMAGE, fetch: f });
  assert.equal(url, 'https://discord.com/channels/700/800/900');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://discord.com/api/webhooks/42/hook-secret-token?wait=true');
  assert.match(calls[0].headers.get('content-type'), /^multipart\/form-data/);
  const form = await calls[0].formData();
  assert.deepEqual(JSON.parse(form.get('payload_json')), {
    content: 'Megaphone ships — é 🐈',
    attachments: [{ id: 0, filename: 'cat.png', description: 'A cat on a keyboard' }],
  });
  assert.equal(form.get('files[0]').name, 'cat.png');
  assert.deepEqual(new Uint8Array(await form.get('files[0]').arrayBuffer()), IMAGE.bytes);
});

test('discord : without guild_id the result is ok <id> ; text only has no file part', async () => {
  const { f, calls } = fakeFetch(() => Response.json({ id: '900', channel_id: '800' }));
  const p = post();
  delete p.meta.image;
  assert.deepEqual(await publish(p, 'discord', { creds: CREDS, fetch: f }), { url: 'ok 900' });
  const form = await calls[0].formData();
  assert.equal(form.get('files[0]'), null);
  assert.deepEqual(JSON.parse(form.get('payload_json')), { content: 'Megaphone ships — é 🐈' });
});

test('publish refuses over-limit text and missing settings before any call', async () => {
  const { f, calls } = fakeFetch(bskyRoutes);
  const long = { ...post(), body: 'a'.repeat(301), meta: { networks: ['bluesky'] } };
  await assert.rejects(publish(long, 'bluesky', { creds: CREDS, fetch: f }), /301 \/ 300/);
  await assert.rejects(publish(post(), 'mastodon', { creds: { ...CREDS, mastoToken: '' }, fetch: f }), /missing Mastodon token/);
  assert.deepEqual(missing('discord', {}), ['Discord webhook URL']);
  assert.equal(calls.length, 0);
});

test('loadImage : images only, mp4 refused, path guarded', async () => {
  const read = async (p) => enc.encode(p);
  assert.equal(await loadImage({ meta: {} }, read), null);
  const img = await loadImage({ meta: { image: 'img/a.b.JPG', alt: 'x' } }, read);
  assert.deepEqual([img.type, img.name, img.alt, dec.decode(img.bytes)], ['image/jpeg', 'a.b.JPG', 'x', 'img/a.b.JPG']);
  await assert.rejects(loadImage({ meta: { image: 'img/clip.mp4' } }, read), /video upload is not supported yet/);
  await assert.rejects(loadImage({ meta: { image: '../secret.png' } }, read), /expected img/);
  await assert.rejects(loadImage({ meta: { image: 'img/notes.txt' } }, read), /expected \.png/);
});

// --- result recording ----------------------------------------------------------

test('record → serialize → parse keeps the URL, the unknown keys and the failure line', () => {
  const p = parse('---\ndate: 2026-11-03\nnetworks: all\ncampaign: launch\nstatus: draft\n---\nHello.\n');
  record(p, 'bluesky', { url: 'https://bsky.app/profile/meitogi.bsky.social/post/3kxyz' });
  const error = `discord : HTTP 401 Unauthorized at ${CREDS.discordWebhook}\nwith password app-pass-1234 and Bearer masto-tok`;
  record(p, 'discord', { error, at: new Date('2026-11-03T09:00:00.123Z') }, Object.values(CREDS));
  const text = serialize(p);
  assert.deepEqual(Object.keys(parse(text).meta), ['date', 'networks', 'campaign', 'status', 'bluesky', 'discord']);
  const back = parse(text);
  assert.equal(back.meta.campaign, 'launch');
  assert.equal(back.meta.bluesky, 'https://bsky.app/profile/meitogi.bsky.social/post/3kxyz');
  assert.equal(back.meta.discord, 'failed 2026-11-03T09:00:00Z discord : HTTP 401 Unauthorized at <url> with password *** and Bearer ***');
  assert.ok(back.meta.discord.length <= 120);
  for (const secret of ['hook-secret-token', 'app-pass-1234', 'masto-tok', 'webhooks/42']) assert.ok(!text.includes(secret), secret);
  assert.equal(posted(back, 'bluesky'), back.meta.bluesky);
  assert.equal(posted(back, 'discord'), null);
});

test('record : a failure carrying « : » and « [ » survives parse as a plain string', () => {
  const p = { meta: { status: 'draft' }, body: 'Hi.', long: null };
  record(p, 'mastodon', { error: 'HTTP 422 [bad]: field "status" is required', at: new Date('2026-11-03T09:00:00Z') });
  assert.equal(parse(serialize(p)).meta.mastodon, 'failed 2026-11-03T09:00:00Z HTTP 422 [bad]: field "status" is required');
});

test('record caps a long failure at 120 characters', () => {
  const p = { meta: {}, body: '', long: null };
  record(p, 'mastodon', { error: 'x'.repeat(300) });
  assert.equal(p.meta.mastodon.length, 120);
  assert.match(p.meta.mastodon, /^failed \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ x+…$/);
});

// --- the CLI loop ---------------------------------------------------------------

const ENV = {
  BLUESKY_HANDLE: CREDS.bskyHandle,
  BLUESKY_APP_PASSWORD: CREDS.bskyPassword,
  MASTODON_URL: CREDS.mastoUrl,
  MASTODON_TOKEN: CREDS.mastoToken,
  DISCORD_WEBHOOK: CREDS.discordWebhook,
};

async function tempPost(text, image) {
  const dir = await mkdtemp(join(tmpdir(), 'megaphone-pub-'));
  await mkdir(join(dir, 'img'));
  if (image) await writeFile(join(dir, 'img', 'cat.png'), image);
  const file = join(dir, '2026-11-03-ship.md');
  await writeFile(file, text);
  return { dir, file };
}

test('cli : a 401 from each network is recorded, the others still run, exit count = failures', async () => {
  const { dir, file } = await tempPost('---\nnetworks: all\nstatus: draft\n---\nHello.\n');
  const { f, calls } = fakeFetch((req) => Response.json({ error: 'AuthenticationRequired', message: `bad token for ${req.url}` }, { status: 401 }));
  const lines = [];
  try {
    const failed = await run({ file, env: ENV, fetch: f, log: (l) => lines.push(l) });
    assert.equal(failed, 3);
    assert.equal(calls.length, 3);
    const meta = parse(await readFile(file, 'utf8')).meta;
    assert.match(meta.bluesky, /^failed \S+Z bluesky session : HTTP 401 bad token for <url>$/);
    assert.match(meta.mastodon, /^failed \S+Z mastodon status : HTTP 401 bad token for <url>$/);
    assert.match(meta.discord, /^failed \S+Z discord : HTTP 401 bad token for <url>$/);
    assert.equal(meta.status, 'draft');
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes('hook-secret-token'));
    assert.deepEqual(lines.filter((l) => l.includes('not built yet')), [
      'threads : not built yet, session 4',
      'linkedin : not built yet, session 4',
      'facebook : not built yet, session 4',
      'instagram : not built yet, session 4',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cli : one network failing does not stop the next ; a done network is skipped unless forced', async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const { dir, file } = await tempPost('---\nnetworks: [bluesky, discord]\nimage: img/cat.png\nalt: A cat\nstatus: ready\nmastodon: https://fosstodon.org/@m/1\n---\nHello.\n', png);
  const { f, calls } = fakeFetch((req) => (req.url.includes('bsky') ? new Response('nope', { status: 401 }) : Response.json({ id: '9', channel_id: '8', guild_id: '7' })));
  try {
    assert.equal(await run({ file, env: ENV, fetch: f, log: () => {} }), 1);
    let meta = parse(await readFile(file, 'utf8')).meta;
    assert.match(meta.bluesky, /^failed .* HTTP 401 nope$/);
    assert.equal(meta.discord, 'https://discord.com/channels/7/8/9');
    const form = await calls.at(-1).formData();
    assert.deepEqual(new Uint8Array(await form.get('files[0]').arrayBuffer()), png);

    const before = calls.length;
    assert.equal(await run({ file, networks: ['discord', 'mastodon'], env: ENV, fetch: f, log: () => {} }), 0);
    assert.equal(calls.length, before);
    await run({ file, networks: ['discord'], force: true, env: ENV, fetch: f, log: () => {} });
    assert.equal(calls.length, before + 1);
    meta = parse(await readFile(file, 'utf8')).meta;
    assert.deepEqual(Object.keys(meta), ['networks', 'image', 'alt', 'status', 'mastodon', 'bluesky', 'discord']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cli : an mp4 is refused on every network without a call', async () => {
  const { dir, file } = await tempPost('---\nnetworks: [bluesky, mastodon, discord]\nimage: img/clip.mp4\nstatus: draft\n---\nHello.\n');
  const { f, calls } = fakeFetch(() => Response.json({}));
  try {
    assert.equal(await run({ file, env: ENV, fetch: f, log: () => {} }), 3);
    assert.equal(calls.length, 0);
    const meta = parse(await readFile(file, 'utf8')).meta;
    for (const n of ['bluesky', 'mastodon', 'discord']) assert.match(meta[n], /video upload is not supported yet : images only$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Dev.to -----------------------------------------------------------------------

const devtoPost = () => ({
  meta: { networks: ['devto'], title: 'Megaphone ships', tags: ['Claude-Code', 'OSS', 'oss', 'Web Dev', 'a_b', 'sixth'], image: 'img/cat.png' },
  body: 'Body with a [link](https://a.io) & é 🐈\n\nSecond paragraph.',
  long: null,
});
const DEVTO_CREDS = { devtoKey: 'devto-secret-key' };

test('devto : POST /api/articles with api-key, the v1 Accept, title, exact body, tags capped and lower-cased', async () => {
  const { f, calls } = fakeFetch(() => Response.json({ id: 1, url: 'https://dev.to/meitogi/megaphone-ships-1a2b' }, { status: 201 }));
  const p = devtoPost();
  const { url } = await publish(p, 'devto', { creds: DEVTO_CREDS, fetch: f });
  assert.equal(url, 'https://dev.to/meitogi/megaphone-ships-1a2b');
  assert.equal(calls.length, 1);
  const [req] = calls;
  assert.equal(req.url, 'https://dev.to/api/articles');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.get('api-key'), 'devto-secret-key');
  assert.equal(req.headers.get('accept'), 'application/vnd.forem.api-v1+json');
  assert.equal(req.headers.get('content-type'), 'application/json');
  assert.deepEqual(await req.json(), {
    article: { title: 'Megaphone ships', body_markdown: p.body, published: true, tags: 'claudecode,oss,webdev,ab' },
  });
  assert.deepEqual(devtoTags(['Claude-Code', 'OSS', 'oss', 'Web Dev', 'a_b', 'sixth']), ['claudecode', 'oss', 'webdev', 'ab']);
  assert.deepEqual(devtoTags(['---', 'C++']), ['c']);
  assert.deepEqual(devtoTags(undefined), []);
});

test('devto : the cover is the raw.githubusercontent.com URL only when the repository is known', async () => {
  const { f, calls } = fakeFetch(() => Response.json({ url: 'https://dev.to/x' }, { status: 201 }));
  await publish(devtoPost(), 'devto', { creds: DEVTO_CREDS, fetch: f, repository: 'meitogi/megaphone' });
  await publish(devtoPost(), 'devto', { creds: DEVTO_CREDS, fetch: f });
  const noTags = devtoPost();
  delete noTags.meta.tags;
  delete noTags.meta.image;
  await publish(noTags, 'devto', { creds: DEVTO_CREDS, fetch: f, repository: 'meitogi/megaphone' });
  const [withRepo, without, bare] = await Promise.all(calls.map((c) => c.json()));
  assert.equal(withRepo.article.main_image, 'https://raw.githubusercontent.com/meitogi/megaphone/main/posts/img/cat.png');
  assert.ok(!('main_image' in without.article));
  assert.deepEqual(Object.keys(bare.article), ['title', 'body_markdown', 'published']);
});

test('devto : no title, no key → no call', async () => {
  const { f, calls } = fakeFetch(() => Response.json({ url: 'https://dev.to/x' }));
  const p = devtoPost();
  delete p.meta.title;
  await assert.rejects(publish(p, 'devto', { creds: DEVTO_CREDS, fetch: f }), /^Error: devto : needs a title$/);
  await assert.rejects(publish(devtoPost(), 'devto', { creds: {}, fetch: f }), /^Error: devto : missing Dev\.to API key$/);
  assert.equal(calls.length, 0);
  assert.deepEqual(ACTION, ['bluesky', 'mastodon', 'discord', 'devto']);
});

test('cli : devto publishes from DEVTO_API_KEY, the key never in a failed line, x is manual', async () => {
  const { dir, file } = await tempPost('---\nnetworks: [devto, x]\ntitle: Ship\nstatus: draft\n---\nHello.\n');
  const env = { ...ENV, DEVTO_API_KEY: 'devto-secret-key' };
  // The error body echoes the key, as a careless server might.
  const { f, calls } = fakeFetch((req) => Response.json({ error: `api-key ${req.headers.get('api-key')} is not valid`, status: 401 }, { status: 401 }));
  const lines = [];
  try {
    assert.equal(creds(env).devtoKey, 'devto-secret-key');
    assert.equal(await run({ file, env, fetch: f, log: (l) => lines.push(l) }), 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.get('api-key'), 'devto-secret-key');
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes('devto-secret-key'));
    assert.match(parse(text).meta.devto, /^failed \S+Z devto : HTTP 401 api-key \*\*\* is not valid$/);
    assert.deepEqual(lines.slice(1), ['x : manual, Compose in the page']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
