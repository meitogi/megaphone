import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../lib/post.mjs';
import { publish, configured } from '../lib/publish.mjs';
import { GRAPH, THREADS, POLL_MS, POLL_MAX } from '../lib/meta.mjs';
import { run, creds, able } from '../scripts/publish.mjs';
import { fakeFetch, trail } from './double.mjs';

const JPG = { bytes: new Uint8Array([255, 216, 255, 224, 1, 2, 3]), type: 'image/jpeg', alt: 'A cat', name: 'cat.jpg' };
const PNG = { ...JPG, type: 'image/png', name: 'cat.png' };
const LINK = 'https://github.com/meitogi/megaphone';
const post = (meta = {}) => ({
  meta: { networks: ['threads', 'facebook', 'instagram'], link: LINK, tags: ['oss'], image: 'img/cat.jpg', alt: 'A cat', ...meta },
  body: 'Megaphone ships — é 🐈',
  long: null,
});
const CREDS = { threadsUserId: '17841400', threadsToken: 'th-secret-token', fbPageId: '1234', fbPageToken: 'fb-secret-token', igUserId: '9876' };
const REPO = 'meitogi/megaphone';
const IMAGE_URL = 'https://raw.githubusercontent.com/meitogi/megaphone/main/posts/img/cat.jpg';
const token = (req) => new URL(req.url).searchParams.get('access_token');
const form = async (req) => Object.fromEntries(new URLSearchParams(await req.text()));

// --- Threads -------------------------------------------------------------------

function threadsRoutes({ polls = 1, status = 'FINISHED', permalink = true } = {}) {
  let reads = 0;
  return (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/v1.0/17841400/threads') return Response.json({ id: 'c1' });
    if (u.pathname === '/v1.0/c1') return Response.json(++reads < polls ? { status: 'IN_PROGRESS', id: 'c1' } : { status, error_message: status === 'ERROR' ? 'Media is too large' : undefined, id: 'c1' });
    if (u.pathname === '/v1.0/17841400/threads_publish') return Response.json({ id: 'm1' });
    if (u.pathname === '/v1.0/m1') return permalink ? Response.json({ permalink: 'https://www.threads.net/@meitogi/post/ABC', id: 'm1' }) : Response.json({ error: { message: 'Tried accessing nonexisting field', type: 'OAuthException', code: 100 } }, { status: 400 });
    return new Response('?', { status: 500 });
  };
}

test('threads : image container by raw URL, polled, published, permalink ; token only as a query param', async () => {
  const { f, calls } = fakeFetch(threadsRoutes({ polls: 2 }));
  const slept = [];
  const result = await publish(post(), 'threads', { creds: CREDS, image: JPG, fetch: f, repository: REPO, sleep: async (ms) => slept.push(ms) });
  assert.deepEqual(result, { url: 'https://www.threads.net/@meitogi/post/ABC' });
  assert.deepEqual(trail(calls), [
    'POST graph.threads.net/v1.0/17841400/threads',
    'GET graph.threads.net/v1.0/c1',
    'GET graph.threads.net/v1.0/c1',
    'POST graph.threads.net/v1.0/17841400/threads_publish',
    'GET graph.threads.net/v1.0/m1',
  ]);
  for (const c of calls) {
    assert.equal(token(c), 'th-secret-token');
    assert.equal(c.headers.get('authorization'), null);
  }
  assert.deepEqual(slept, [POLL_MS]);
  assert.match(calls[0].headers.get('content-type'), /^application\/x-www-form-urlencoded/);
  assert.deepEqual(await form(calls[0]), { media_type: 'IMAGE', text: `Megaphone ships — é 🐈\n\n${LINK}\n\n#oss`, image_url: IMAGE_URL });
  assert.equal(new URL(calls[1].url).searchParams.get('fields'), 'status,error_message');
  assert.deepEqual(await form(calls[3]), { creation_id: 'c1' });
  assert.equal(new URL(calls[4].url).searchParams.get('fields'), 'permalink');
  assert.equal(THREADS, 'https://graph.threads.net/v1.0');
});

test('threads : text only needs no repository ; an image without one is refused before any call', async () => {
  const { f, calls } = fakeFetch(threadsRoutes());
  const p = post();
  delete p.meta.image;
  await publish(p, 'threads', { creds: CREDS, fetch: f, sleep: async () => {} });
  assert.deepEqual(await form(calls[0]), { media_type: 'TEXT', text: `Megaphone ships — é 🐈\n\n${LINK}\n\n#oss` });
  const before = calls.length;
  await assert.rejects(publish(post(), 'threads', { creds: CREDS, image: JPG, fetch: f }), /^Error: threads : needs GITHUB_REPOSITORY for the image URL$/);
  assert.equal(calls.length, before);
});

test('threads : a container in ERROR fails with the reason, nothing published ; a stuck one gives up', async () => {
  const { f, calls } = fakeFetch(threadsRoutes({ status: 'ERROR' }));
  await assert.rejects(publish(post(), 'threads', { creds: CREDS, image: JPG, fetch: f, repository: REPO, sleep: async () => {} }), /threads container : ERROR Media is too large/);
  assert.ok(!trail(calls).some((c) => c.includes('threads_publish')));
  const stuck = fakeFetch(threadsRoutes({ polls: POLL_MAX + 5 }));
  await assert.rejects(publish(post(), 'threads', { creds: CREDS, image: JPG, fetch: stuck.f, repository: REPO, sleep: async () => {} }), /still IN_PROGRESS after 30 reads/);
});

test('threads : a failing permalink read after publish still records ok <id> with a note ; a 2xx without an id too', async () => {
  const { f, calls } = fakeFetch(threadsRoutes({ permalink: false }));
  const result = await publish(post(), 'threads', { creds: CREDS, image: JPG, fetch: f, repository: REPO, sleep: async () => {} });
  assert.deepEqual(result, { url: 'ok m1', note: 'threads permalink : HTTP 400 Tried accessing nonexisting field' });
  assert.equal(trail(calls).filter((c) => c.includes('threads_publish')).length, 1);
  const routes = threadsRoutes();
  const quiet = fakeFetch((req) => (req.url.includes('threads_publish') ? Response.json({ success: true }) : routes(req)));
  assert.deepEqual(await publish(post(), 'threads', { creds: CREDS, image: JPG, fetch: quiet.f, repository: REPO, sleep: async () => {} }), { url: 'ok threads', note: 'no id in the publish answer' });
  const fb = fakeFetch(() => Response.json({ success: true }));
  const p = post({ link: undefined });
  delete p.meta.image;
  assert.deepEqual(await publish(p, 'facebook', { creds: CREDS, fetch: fb.f }), { url: 'ok facebook', note: 'no id in the answer' });
});

// --- Facebook --------------------------------------------------------------------

function facebookRoutes({ comment = true } = {}) {
  return (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/v26.0/1234/photos') return Response.json({ id: 'ph1', post_id: '1234_777' });
    if (u.pathname === '/v26.0/1234/feed') return Response.json({ id: '1234_778' });
    if (/^\/v26\.0\/1234_77[78]\/comments$/.test(u.pathname)) return comment ? Response.json({ id: '1234_777_1' }) : Response.json({ error: { message: '(#200) Requires pages_manage_engagement', type: 'OAuthException', code: 200 } }, { status: 403 });
    return new Response('?', { status: 500 });
  };
}

test('facebook : /photos with the bytes and the message, then the link as a first comment', async () => {
  const { f, calls } = fakeFetch(facebookRoutes());
  const result = await publish(post(), 'facebook', { creds: CREDS, image: JPG, fetch: f });
  assert.deepEqual(result, { url: 'https://www.facebook.com/1234_777' });
  assert.deepEqual(trail(calls), ['POST graph.facebook.com/v26.0/1234/photos', 'POST graph.facebook.com/v26.0/1234_777/comments']);
  for (const c of calls) assert.equal(token(c), 'fb-secret-token');
  assert.match(calls[0].headers.get('content-type'), /^multipart\/form-data/);
  const fd = await calls[0].formData();
  assert.equal(fd.get('message'), 'Megaphone ships — é 🐈');
  assert.equal(fd.get('source').name, 'cat.jpg');
  assert.equal(fd.get('source').type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await fd.get('source').arrayBuffer()), JPG.bytes);
  assert.deepEqual(await form(calls[1]), { message: LINK });
  assert.equal(GRAPH, 'https://graph.facebook.com/v26.0');
});

test('facebook : text only goes to /feed ; the long variant wins ; no link, no comment', async () => {
  const { f, calls } = fakeFetch(facebookRoutes());
  const p = post({ link: undefined });
  delete p.meta.image;
  p.long = 'The long story, in full.';
  assert.deepEqual(await publish(p, 'facebook', { creds: CREDS, fetch: f }), { url: 'https://www.facebook.com/1234_778' });
  assert.deepEqual(trail(calls), ['POST graph.facebook.com/v26.0/1234/feed']);
  assert.deepEqual(await form(calls[0]), { message: 'The long story, in full.' });
});

test('facebook : a refused comment keeps the post URL and reports the follow-up', async () => {
  const { f } = fakeFetch(facebookRoutes({ comment: false }));
  assert.deepEqual(await publish(post(), 'facebook', { creds: CREDS, image: JPG, fetch: f }), {
    url: 'https://www.facebook.com/1234_777',
    note: 'facebook comment : HTTP 403 (#200) Requires pages_manage_engagement',
  });
});

// --- Instagram -------------------------------------------------------------------

function instagramRoutes() {
  let reads = 0;
  return (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/v26.0/9876/media') return Response.json({ id: 'ig-c1' });
    if (u.pathname === '/v26.0/ig-c1') return Response.json(++reads < 2 ? { status_code: 'IN_PROGRESS', id: 'ig-c1' } : { status_code: 'FINISHED', status: 'Finished', id: 'ig-c1' });
    if (u.pathname === '/v26.0/9876/media_publish') return Response.json({ id: 'ig-m1' });
    if (u.pathname === '/v26.0/ig-m1') return Response.json({ permalink: 'https://www.instagram.com/p/XYZ/', id: 'ig-m1' });
    return new Response('?', { status: 500 });
  };
}

test('instagram : container by raw URL with caption and alt, status_code polled, published, permalink ; page token', async () => {
  const { f, calls } = fakeFetch(instagramRoutes());
  const slept = [];
  const result = await publish(post(), 'instagram', { creds: CREDS, image: JPG, fetch: f, repository: REPO, sleep: async (ms) => slept.push(ms) });
  assert.deepEqual(result, { url: 'https://www.instagram.com/p/XYZ/' });
  assert.deepEqual(trail(calls), [
    'POST graph.facebook.com/v26.0/9876/media',
    'GET graph.facebook.com/v26.0/ig-c1',
    'GET graph.facebook.com/v26.0/ig-c1',
    'POST graph.facebook.com/v26.0/9876/media_publish',
    'GET graph.facebook.com/v26.0/ig-m1',
  ]);
  for (const c of calls) assert.equal(token(c), 'fb-secret-token');
  assert.deepEqual(await form(calls[0]), { image_url: IMAGE_URL, caption: 'Megaphone ships — é 🐈', alt_text: 'A cat' });
  assert.equal(new URL(calls[1].url).searchParams.get('fields'), 'status_code,status');
  assert.deepEqual(await form(calls[3]), { creation_id: 'ig-c1' });
  assert.deepEqual(slept, [POLL_MS]);
});

test('instagram : PNG, no repository, no page token → refused before any call', async () => {
  const { f, calls } = fakeFetch(instagramRoutes());
  await assert.rejects(publish(post({ image: 'img/cat.png' }), 'instagram', { creds: CREDS, image: PNG, fetch: f, repository: REPO }), /instagram : JPEG only, cat\.png is image\/png/);
  await assert.rejects(publish(post(), 'instagram', { creds: CREDS, image: JPG, fetch: f }), /instagram : needs GITHUB_REPOSITORY/);
  await assert.rejects(publish(post(), 'instagram', { creds: { igUserId: '9876' }, image: JPG, fetch: f, repository: REPO }), /instagram : missing Facebook page token/);
  await assert.rejects(publish(post(), 'instagram', { creds: {}, image: JPG, fetch: f, repository: REPO }), /instagram : missing Instagram user id/);
  assert.equal(calls.length, 0);
});

// --- configuration and the CLI loop ------------------------------------------------

const ENV = {
  THREADS_USER_ID: CREDS.threadsUserId,
  THREADS_TOKEN: CREDS.threadsToken,
  FB_PAGE_ID: CREDS.fbPageId,
  FB_PAGE_TOKEN: CREDS.fbPageToken,
  IG_USER_ID: CREDS.igUserId,
  LINKEDIN_PERSON_URN: 'urn:li:person:abc',
  LINKEDIN_TOKEN: 'li-secret-token',
  GITHUB_REPOSITORY: REPO,
};

test('creds(env) maps the seven Meta / LinkedIn secrets ; configured() and able() follow the env', () => {
  const c = creds(ENV);
  assert.deepEqual([c.threadsUserId, c.threadsToken, c.fbPageId, c.fbPageToken, c.igUserId, c.linkedinPersonUrn, c.linkedinToken],
    ['17841400', 'th-secret-token', '1234', 'fb-secret-token', '9876', 'urn:li:person:abc', 'li-secret-token']);
  assert.deepEqual(able(ENV), ['threads', 'facebook', 'instagram', 'linkedin']);
  assert.deepEqual(able({ FB_PAGE_TOKEN: 'x', BLUESKY_HANDLE: 'h' }), ['bluesky', 'facebook']);
  assert.equal(configured('instagram', { fbPageToken: 'x' }), false);
  assert.equal(configured('instagram', { igUserId: '1' }), true);
  assert.deepEqual(able({}), []);
});

async function tempPost(text, image) {
  const dir = await mkdtemp(join(tmpdir(), 'megaphone-meta-'));
  await mkdir(join(dir, 'img'));
  if (image) await writeFile(join(dir, 'img', 'cat.jpg'), image);
  const file = join(dir, '2026-11-03-ship.md');
  await writeFile(file, text);
  return { dir, file };
}

test('cli : a Graph error object is read, the token never lands in the file, a partly set network fails on what is missing', async () => {
  const { dir, file } = await tempPost('---\nnetworks: [threads, facebook, instagram]\nstatus: ready\n---\nHello.\n');
  const { f, calls } = fakeFetch((req) => Response.json({ error: { message: `Invalid OAuth access token ${token(req)}`, type: 'OAuthException', code: 190 } }, { status: 401 }));
  const lines = [];
  try {
    const env = { ...ENV };
    delete env.FB_PAGE_ID;
    assert.equal(await run({ file, env, fetch: f, log: (l) => lines.push(l) }), 2);
    assert.equal(calls.length, 1);
    const text = await readFile(file, 'utf8');
    const meta = parse(text).meta;
    assert.match(meta.threads, /^failed \S+Z threads container : HTTP 401 Invalid OAuth access token \*\*\*$/);
    assert.match(meta.facebook, /^failed \S+Z facebook : missing Facebook page id$/);
    assert.equal(meta.instagram, 'skipped no image');
    assert.ok(!text.includes('th-secret-token'));
    assert.ok(!text.includes('[object Object]'));
    assert.deepEqual(lines, [`threads : ${meta.threads}`, `facebook : ${meta.facebook}`, 'instagram : skipped no image']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cli : instagram without an image is skipped, not failed ; a later image is picked up ; follow-up notes are logged', async () => {
  const { dir, file } = await tempPost('---\nnetworks: [instagram]\nstatus: ready\n---\nHello.\n', JPG.bytes);
  const routes = instagramRoutes();
  const { f, calls } = fakeFetch((req) => (new URL(req.url).pathname === '/v26.0/ig-m1' ? new Response('down', { status: 503 }) : routes(req)));
  const lines = [];
  try {
    assert.equal(await run({ file, env: ENV, fetch: f, sleep: async () => {}, log: (l) => lines.push(l) }), 0);
    assert.equal(calls.length, 0);
    let meta = parse(await readFile(file, 'utf8')).meta;
    assert.equal(meta.instagram, 'skipped no image');
    assert.deepEqual(lines, ['instagram : skipped no image']);

    await writeFile(file, '---\nnetworks: [instagram]\nimage: img/cat.jpg\nalt: A cat\nstatus: ready\ninstagram: skipped no image\n---\nHello.\n');
    lines.length = 0;
    assert.equal(await run({ file, env: ENV, fetch: f, sleep: async () => {}, log: (l) => lines.push(l) }), 0);
    meta = parse(await readFile(file, 'utf8')).meta;
    assert.equal(meta.instagram, 'ok ig-m1');
    assert.deepEqual(lines, ['instagram : ok ig-m1', 'instagram : published, but instagram permalink : HTTP 503 down']);

    // Already out : no second publish, whatever the follow-up did.
    const before = calls.length;
    assert.equal(await run({ file, env: ENV, fetch: f, sleep: async () => {}, log: () => {} }), 0);
    assert.equal(calls.length, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
