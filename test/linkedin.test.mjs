import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../lib/post.mjs';
import { publish } from '../lib/publish.mjs';
import { littleText, LINKEDIN_VERSION, UPLOAD_HOST } from '../lib/linkedin.mjs';
import { run } from '../scripts/publish.mjs';
import { fakeFetch, trail } from './double.mjs';

const JPG = { bytes: new Uint8Array([255, 216, 255, 224, 1, 2, 3]), type: 'image/jpeg', alt: 'A cat', name: 'cat.jpg' };
const LINK = 'https://github.com/meitogi/megaphone';
const CREDS = { linkedinPersonUrn: 'urn:li:person:abc', linkedinToken: 'li-secret-token' };
const post = (meta = {}) => ({ meta: { networks: ['linkedin'], link: LINK, image: 'img/cat.jpg', alt: 'A cat', ...meta }, body: 'Megaphone ships (v1) — é 🐈 #oss', long: null });
const URN = 'urn:li:share:6844785523593134080';
const POST_URL = 'https://www.linkedin.com/feed/update/urn:li:share:6844785523593134080/';
const BODY = {
  author: 'urn:li:person:abc',
  commentary: 'Megaphone ships \\(v1\\) — é 🐈 \\#oss',
  visibility: 'PUBLIC',
  distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
  lifecycleState: 'PUBLISHED',
  isReshareDisabledByAuthor: false,
};

function routes({ host = UPLOAD_HOST, comment = 201 } = {}) {
  return (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/rest/images' && u.searchParams.get('action') === 'initializeUpload') {
      return Response.json({ value: { uploadUrlExpiresAt: 1, uploadUrl: `https://${host}/dms-uploads/C4E10AQ/uploaded-image/0?ca=vector_feedshare&sig=x`, image: 'urn:li:image:C4E10AQ' } });
    }
    if (u.pathname.startsWith('/dms-uploads/')) return new Response(null, { status: 201 });
    if (u.pathname === '/rest/posts') return new Response(null, { status: 201, headers: { 'x-restli-id': URN } });
    if (u.pathname === `/rest/socialActions/${encodeURIComponent(URN)}/comments`) {
      return comment === 201 ? new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:comment:(urn:li:share:1,2)' } }) : Response.json({ message: 'Not enough permissions to access: comments.CREATE', serviceErrorCode: 100, status: comment }, { status: comment });
    }
    return new Response('?', { status: 500 });
  };
}

test('littleText escapes every reserved character once and nothing else', () => {
  assert.equal(littleText('a|b{c}d@e[f]g(h)i<j>k#l*m_n~o\\p'), 'a\\|b\\{c\\}d\\@e\\[f\\]g\\(h\\)i\\<j\\>k\\#l\\*m\\_n\\~o\\\\p');
  assert.equal(littleText('Plain text, é 🐈 — with. punctuation! and ?\nnewline'), 'Plain text, é 🐈 — with. punctuation! and ?\nnewline');
  assert.equal(littleText(''), '');
});

test('linkedin : text-only post with the versioned headers, the exact body, the URL from x-restli-id, the link as a comment', async () => {
  const { f, calls } = fakeFetch(routes());
  const p = post();
  delete p.meta.image;
  assert.deepEqual(await publish(p, 'linkedin', { creds: CREDS, fetch: f }), { url: POST_URL });
  assert.deepEqual(trail(calls), ['POST api.linkedin.com/rest/posts', 'POST api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A6844785523593134080/comments']);
  for (const c of calls) {
    assert.equal(c.headers.get('authorization'), 'Bearer li-secret-token');
    assert.equal(c.headers.get('linkedin-version'), LINKEDIN_VERSION);
    assert.equal(c.headers.get('x-restli-protocol-version'), '2.0.0');
    assert.equal(c.headers.get('content-type'), 'application/json');
  }
  assert.match(LINKEDIN_VERSION, /^20\d{4}$/);
  assert.deepEqual(await calls[0].json(), BODY);
  assert.deepEqual(await calls[1].json(), { actor: 'urn:li:person:abc', object: URN, message: { text: LINK } });
});

test('linkedin : image → initializeUpload, PUT of the bytes with the bearer, then the post carries the image URN and alt', async () => {
  const { f, calls } = fakeFetch(routes());
  assert.deepEqual(await publish(post(), 'linkedin', { creds: CREDS, image: JPG, fetch: f }), { url: POST_URL });
  assert.deepEqual(trail(calls), [
    'POST api.linkedin.com/rest/images',
    'PUT www.linkedin.com/dms-uploads/C4E10AQ/uploaded-image/0',
    'POST api.linkedin.com/rest/posts',
    'POST api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A6844785523593134080/comments',
  ]);
  assert.deepEqual(await calls[0].json(), { initializeUploadRequest: { owner: 'urn:li:person:abc' } });
  assert.equal(calls[1].headers.get('authorization'), 'Bearer li-secret-token');
  assert.equal(calls[1].headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await calls[1].arrayBuffer()), JPG.bytes);
  assert.deepEqual(await calls[2].json(), { ...BODY, content: { media: { id: 'urn:li:image:C4E10AQ', altText: 'A cat' } } });
});

test('linkedin : an upload URL on another host stops before the PUT and names it', async () => {
  const { f, calls } = fakeFetch(routes({ host: 'media-upload.example.net' }));
  await assert.rejects(publish(post(), 'linkedin', { creds: CREDS, image: JPG, fetch: f }), /^Error: linkedin : upload host media-upload\.example\.net is not allowlisted \(expected www\.linkedin\.com\)$/);
  assert.deepEqual(trail(calls), ['POST api.linkedin.com/rest/images']);
});

test('linkedin : a refused comment keeps the post as a success, and the next run does not post again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'megaphone-li-'));
  const file = join(dir, '2026-11-03-ship.md');
  await writeFile(file, `---\nnetworks: [linkedin]\nlink: ${LINK}\nstatus: ready\n---\nHello (there).\n`);
  const { f, calls } = fakeFetch(routes({ comment: 403 }));
  const env = { LINKEDIN_PERSON_URN: CREDS.linkedinPersonUrn, LINKEDIN_TOKEN: CREDS.linkedinToken };
  const lines = [];
  try {
    assert.equal(await run({ file, env, fetch: f, log: (l) => lines.push(l) }), 0);
    assert.equal(parse(await readFile(file, 'utf8')).meta.linkedin, POST_URL);
    assert.deepEqual(lines, [`linkedin : ${POST_URL}`, 'linkedin : published, but linkedin comment : HTTP 403 Not enough permissions to access: comments.CREATE']);
    const before = calls.length;
    assert.equal(await run({ file, env, fetch: f, log: () => {} }), 0);
    assert.equal(calls.length, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('linkedin : a 4xx on the post is a failure with LinkedIn\'s message and no token ; no x-restli-id is still a success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'megaphone-li-'));
  const file = join(dir, '2026-11-03-ship.md');
  await writeFile(file, '---\nnetworks: [linkedin]\nstatus: ready\n---\nHello.\n');
  const env = { LINKEDIN_PERSON_URN: CREDS.linkedinPersonUrn, LINKEDIN_TOKEN: CREDS.linkedinToken };
  try {
    const bad = fakeFetch((req) => Response.json({ message: `Empty oauth2_access_token ${req.headers.get('authorization')}`, serviceErrorCode: 401, status: 401 }, { status: 401 }));
    assert.equal(await run({ file, env, fetch: bad.f, log: () => {} }), 1);
    const text = await readFile(file, 'utf8');
    assert.match(parse(text).meta.linkedin, /^failed \S+Z linkedin post : HTTP 401 Empty oauth2_access_token Bearer \*\*\*$/);
    assert.ok(!text.includes('li-secret-token'));
    const quiet = fakeFetch(() => new Response(null, { status: 201 }));
    const p = post({ link: undefined });
    delete p.meta.image;
    assert.deepEqual(await publish(p, 'linkedin', { creds: CREDS, fetch: quiet.f }), { url: 'ok linkedin', note: 'no x-restli-id header on the post response' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
