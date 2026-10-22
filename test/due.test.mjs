import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../lib/post.mjs';
import { due } from '../scripts/due.mjs';

const NOW = Date.parse('2026-11-03T09:30:00Z');
const ENV = {
  BLUESKY_HANDLE: 'meitogi.bsky.social',
  BLUESKY_APP_PASSWORD: 'app-pass',
  MASTODON_URL: 'https://fosstodon.org',
  MASTODON_TOKEN: 'masto-tok',
  DISCORD_WEBHOOK: 'https://discord.com/api/webhooks/1/hook-tok',
  DEVTO_API_KEY: 'devto-key',
};

// A plain (url, init) → Promise<Response>, as fetch : nothing more. Calls kept as Requests.
function fakeFetch() {
  const calls = [];
  const f = async (url, init) => {
    const req = new Request(url, init);
    calls.push(req);
    const u = new URL(req.url);
    if (u.pathname.endsWith('createSession')) return Response.json({ accessJwt: 'jwt', did: 'did:plc:a', handle: 'meitogi.bsky.social' });
    if (u.pathname.endsWith('createRecord')) return Response.json({ uri: `at://did:plc:a/app.bsky.feed.post/r${calls.length}` });
    if (u.host === 'discord.com') return Response.json({ id: '9', channel_id: '8', guild_id: '7' });
    if (u.host === 'dev.to') return Response.json({ url: 'https://dev.to/meitogi/ship-1' }, { status: 201 });
    if (u.host === 'fosstodon.org') return Response.json({ error: 'The access token is invalid' }, { status: 401 });
    return new Response('unexpected', { status: 500 });
  };
  return { f, calls };
}

const post = (meta, body = 'Hello.') => `---\n${meta}\n---\n${body}\n`;
const FILES = {
  'a-draft.md': post('date: 2026-11-01T09:00Z\nnetworks: [discord]\nstatus: draft'),
  'b-future.md': post('date: 2026-11-04T10:31+01:00\nnetworks: [discord]\nstatus: ready'),
  'c-complete.md': post('date: 2026-11-03T10:30+01:00\nnetworks: [bluesky, discord, devto]\ntitle: Ship\nstatus: ready\nkeep: me'),
  'd-retry.md': post('date: 2026-11-02T09:00Z\nnetworks: [bluesky, mastodon]\nstatus: ready'),
  'e-manual.md': post('date: 2026-11-02T09:00Z\nnetworks: [x, threads]\nstatus: ready'),
  'f-nodate.md': post('networks: [discord]\nstatus: ready'),
  'g-baddate.md': post('date: soon\nnetworks: [discord]\nstatus: ready'),
};

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'megaphone-due-'));
  await mkdir(join(dir, 'posts', 'img'), { recursive: true });
  await mkdir(join(dir, 'published'));
  for (const name in FILES) await writeFile(join(dir, 'posts', name), FILES[name]);
  return dir;
}

const hosts = (calls) => calls.map((c) => `${c.method} ${new URL(c.url).host}${new URL(c.url).pathname}`);

test('due : publishes the due posts, moves the complete ones, keeps the others ready and retries only what failed', async () => {
  const dir = await repo();
  const { f, calls } = fakeFetch();
  const lines = [];
  try {
    const failed = await due({ dir, now: NOW, env: ENV, fetch: f, sleep: async () => {}, log: (l) => lines.push(l) });
    assert.equal(failed, 1);
    assert.deepEqual((await readdir(join(dir, 'posts'))).sort(), ['a-draft.md', 'b-future.md', 'd-retry.md', 'f-nodate.md', 'g-baddate.md', 'img']);
    assert.deepEqual((await readdir(join(dir, 'published'))).sort(), ['c-complete.md', 'e-manual.md']);

    // Untouched : the draft, the future post, the two without a usable date.
    for (const name of ['a-draft.md', 'b-future.md', 'f-nodate.md', 'g-baddate.md']) {
      assert.equal(await readFile(join(dir, 'posts', name), 'utf8'), FILES[name], name);
    }
    assert.ok(lines.includes('b-future.md : not due, due 2026-11-04T10:31+01:00'));
    assert.ok(lines.includes('f-nodate.md : not due, no date'));
    assert.ok(lines.includes('g-baddate.md : not due, unparseable date soon'));
    assert.ok(!lines.some((l) => l.startsWith('a-draft.md')));

    // Complete : published, result keys and unknown keys intact, order kept.
    const c = parse(await readFile(join(dir, 'published', 'c-complete.md'), 'utf8'));
    assert.equal(c.meta.status, 'published');
    assert.equal(c.meta.keep, 'me');
    assert.match(c.meta.bluesky, /^https:\/\/bsky\.app\/profile\/meitogi\.bsky\.social\/post\/r\d+$/);
    assert.equal(c.meta.discord, 'https://discord.com/channels/7/8/9');
    assert.equal(c.meta.devto, 'https://dev.to/meitogi/ship-1');
    assert.deepEqual(Object.keys(c.meta), ['date', 'networks', 'title', 'status', 'keep', 'bluesky', 'discord', 'devto']);

    // Only manual / later networks : nothing to send, moved all the same.
    const e = parse(await readFile(join(dir, 'published', 'e-manual.md'), 'utf8'));
    assert.equal(e.meta.status, 'published');
    assert.ok(lines.includes('  x : manual, Compose in the page'));
    assert.ok(lines.includes('  threads : not built yet, session 4'));

    // A failure : stays ready in posts/, the failure written, the success too.
    let d = parse(await readFile(join(dir, 'posts', 'd-retry.md'), 'utf8'));
    assert.equal(d.meta.status, 'ready');
    const bsky = d.meta.bluesky;
    assert.match(bsky, /^https:\/\/bsky\.app\//);
    assert.match(d.meta.mastodon, /^failed \S+Z mastodon status : HTTP 401 The access token is invalid$/);
    assert.ok(lines.includes('d-retry.md : stays ready, retried next run (mastodon)'));

    // Next hour : bluesky is not called again, mastodon is.
    const before = calls.length;
    assert.equal(await due({ dir, now: NOW + 3600e3, env: ENV, fetch: f, sleep: async () => {}, log: () => {} }), 1);
    assert.deepEqual(hosts(calls.slice(before)), ['POST fosstodon.org/api/v1/statuses']);
    d = parse(await readFile(join(dir, 'posts', 'd-retry.md'), 'utf8'));
    assert.equal(d.meta.bluesky, bsky);
    assert.equal(d.meta.status, 'ready');
    const text = await readFile(join(dir, 'posts', 'd-retry.md'), 'utf8');
    for (const secret of ['app-pass', 'masto-tok', 'hook-tok', 'devto-key']) assert.ok(!text.includes(secret), secret);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('due : a retried network that now succeeds completes and moves the post', async () => {
  const dir = await repo();
  const { f } = fakeFetch();
  try {
    await writeFile(join(dir, 'posts', 'd-retry.md'), post('date: 2026-11-02T09:00Z\nnetworks: [bluesky, discord]\nstatus: ready\nbluesky: https://bsky.app/profile/m/post/1\ndiscord: failed 2026-11-02T09:17:00Z discord : HTTP 500'));
    for (const name of ['c-complete.md', 'e-manual.md']) await rm(join(dir, 'posts', name));
    const calls = [];
    const g = async (url, init) => {
      calls.push(new Request(url, init));
      return f(url, init);
    };
    assert.equal(await due({ dir, now: NOW, env: ENV, fetch: g, log: () => {} }), 0);
    assert.deepEqual(hosts(calls), ['POST discord.com/api/webhooks/1/hook-tok']);
    const d = parse(await readFile(join(dir, 'published', 'd-retry.md'), 'utf8'));
    assert.equal(d.meta.status, 'published');
    assert.equal(d.meta.bluesky, 'https://bsky.app/profile/m/post/1');
    assert.equal(d.meta.discord, 'https://discord.com/channels/7/8/9');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
