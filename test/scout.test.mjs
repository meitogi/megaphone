import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';
import { server, thread, claude } from '../scripts/ui.mjs';

// The userscript's pure half, loaded as Tampermonkey would minus the page : no `document`, so main() never runs.
const src = await readFile(new URL('../userscripts/scout.user.js', import.meta.url), 'utf8');
const raw = vm.runInNewContext(`${src}\n;({ score, pick, pickHn, text, threadOf, threadOfHn })`, {});
// Objects built in the vm realm carry its prototypes : bring them back as plain data.
const plain = (fn) => (...args) => JSON.parse(JSON.stringify(fn(...args)));
const score = plain(raw.score);
const pick = plain(raw.pick);
const threadOf = plain(raw.threadOf);
const pickHn = plain(raw.pickHn);
const threadOfHn = plain(raw.threadOfHn);
const text = raw.text;

const NOW = Date.parse('2026-10-28T12:00:00Z');
const post = (over) => ({ data: { id: 'a1', subreddit: 'ClaudeAI', title: 'x', selftext: '', permalink: '/r/ClaudeAI/comments/a1/x/', author: 'someone', created_utc: NOW / 1000 - 3600, num_comments: 0, locked: false, stickied: false, ...over } });

test('score : title hits count double, question bonus, themes listed once', () => {
  assert.deepEqual(score({ title: 'How do I lock down a devcontainer firewall?', selftext: '' }), { score: 3 * 2 + 2 * 2 + 2, topics: ['sandbox'] });
  assert.deepEqual(score({ title: 'My setup', selftext: 'claude code hooks in settings.json' }), { score: 1 + 2 + 2, topics: ['claude-code'] });
  assert.deepEqual(score({ title: 'Look at my cat', selftext: 'so cute?' }), { score: 0, topics: [] });
  assert.equal(score({ title: 'webgl2 port', selftext: '', link_flair_text: 'Help' }).score, 2 * 2 + 2);
});

test('score : whole words only', () => {
  assert.equal(score({ title: 'sandboxed', selftext: 'hookup' }).score, 0);
  assert.equal(score({ title: 'the ctr-mod thing', selftext: '' }).score, 0);
  assert.equal(score({ title: 'CTR on PC', selftext: '' }).score, 2);
});

test('pick : drops old, busy, locked, pinned, mine and done ; best first ; URL and fields kept', () => {
  const listing = { data: { children: [
    post({ id: 'low', title: 'docker question' }),
    post({ id: 'top', title: 'devcontainer firewall egress', permalink: '/r/docker/comments/top/t/', subreddit: 'docker', num_comments: 2 }),
    post({ id: 'old', title: 'devcontainer', created_utc: NOW / 1000 - 25 * 3600 }),
    post({ id: 'busy', title: 'devcontainer', num_comments: 6 }),
    post({ id: 'locked', title: 'devcontainer', locked: true }),
    post({ id: 'pinned', title: 'devcontainer', stickied: true }),
    post({ id: 'mine', title: 'devcontainer', author: 'meitogi' }),
    post({ id: 'done', title: 'devcontainer' }),
    post({ id: 'off', title: 'my cat' }),
  ] } };
  const rows = pick(listing, NOW, { done: NOW }, 'meitogi');
  assert.deepEqual(rows.map((r) => r.id), ['top', 'low']);
  assert.deepEqual(rows[0], { id: 'top', sub: 'docker', title: 'devcontainer firewall egress', url: 'https://www.reddit.com/r/docker/comments/top/t/', age: 3600, comments: 2, score: 14, topics: ['sandbox'] });
});

test('threadOf : post, then top-level comments without stickies or « more », capped', () => {
  const c = (i, over) => ({ kind: 't1', data: { author: `u${i}`, score: 10 - i, body: `body ${i}`, stickied: false, ...over } });
  const json = [
    { data: { children: [{ data: { subreddit: 'ClaudeAI', title: 'Q', selftext: 'details', permalink: '/r/ClaudeAI/comments/a1/q/' } }] } },
    { data: { children: [c(0, { stickied: true }), c(1), { kind: 'more', data: {} }, c(2), c(3, { body: 'x'.repeat(2000) })] } },
  ];
  const t = threadOf(json, 2);
  assert.deepEqual(t, { site: 'reddit', sub: 'ClaudeAI', title: 'Q', body: 'details', url: 'https://www.reddit.com/r/ClaudeAI/comments/a1/q/', comments: [{ author: 'u1', score: 9, body: 'body 1' }, { author: 'u2', score: 8, body: 'body 2' }] });
  assert.equal(threadOf(json).comments[2].body.length, 1500);
});

test('thread : the user message carries sub, URL, title, body and every comment', () => {
  const msg = thread({ site: 'reddit', sub: 'docker', title: 'T?', body: 'B', url: 'https://r/x', comments: [{ author: 'a', score: 3, body: 'C1' }, { author: 'b', score: 1, body: 'C2' }] });
  assert.equal(msg, 'r/docker — https://r/x\n\nTitle: T?\n\nB\n\nTop comments:\n\nu/a (3 points):\nC1\n\nu/b (1 points):\nC2');
  assert.match(thread({ site: 'reddit', sub: 's', title: 't', url: 'u' }), /\(no body\)\n\nTop comments:\n\(none yet\)$/);
});

test('POST /draft : the thread and its site prompt reach the drafter, its answer comes back ; bad input refused', async () => {
  const seen = [];
  const srv = server({ draft: async (input, prompt) => (seen.push([input, prompt]), { draft: 'Use `--network none`.', usage: { in: 900, out: 60, fiveHour: 3, sevenDay: 31 } }) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/draft`;
  try {
    const t = { site: 'reddit', sub: 'docker', title: 'T', body: 'B', url: 'U', comments: [] };
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(t) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { draft: 'Use `--network none`.', usage: { in: 900, out: 60, fiveHour: 3, sevenDay: 31 } });
    assert.deepEqual(seen, [[thread(t), 'reddit-reply.md']]);
    const h = { ...t, site: 'hn', sub: 'HN' };
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(h) })).status, 200);
    assert.deepEqual(seen[1], [thread(h), 'hn-reply.md']);
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ ...t, site: 'x' }) })).status, 400);
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(url, { method: 'POST', body: '{"sub":"x"}' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ ...t, body: 'x'.repeat(70000) }) })).status, 413);
    assert.equal(seen.length, 2);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

function fakeSpawn(code, stdout, stderr = '') {
  const calls = [];
  const run = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    let input = '';
    child.stdin.on('data', (c) => (input += c));
    child.stdin.on('end', () => {
      calls.push({ cmd, args, env: opts.env, input });
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
  return { run, calls };
}

// What `claude -p --output-format stream-json --verbose` prints, trimmed to the fields read.
const STREAM = [
  { type: 'system', subtype: 'init' },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.034 }, seven_day: { utilization: 0.31 } } } },
  { type: 'assistant', message: {} },
  { type: 'result', is_error: false, result: '  Draft text\n', usage: { input_tokens: 2, cache_creation_input_tokens: 1670, cache_read_input_tokens: 649, output_tokens: 57 } },
].map((m) => JSON.stringify(m)).join('\n') + '\n';

test('claude : -p without tools, the prompt file, input on stdin, no API key in the env ; draft, tokens and windows read back', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    const { run, calls } = fakeSpawn(0, STREAM);
    assert.deepEqual(await claude('the thread', { root: '/app', prompt: 'hn-reply.md', run }), { draft: 'Draft text', usage: { fiveHour: 3, sevenDay: 31, in: 2321, out: 57 } });
    assert.equal(calls[0].cmd, 'claude');
    assert.deepEqual(calls[0].args, ['-p', '--safe-mode', '--tools', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--system-prompt-file', '/app/prompts/hn-reply.md']);
    assert.equal(calls[0].input, 'the thread');
    assert.equal('ANTHROPIC_API_KEY' in calls[0].env, false);
    assert.equal(calls[0].env.PATH, process.env.PATH);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('claude : a non-zero exit rejects with its stderr, an error result with its text', async () => {
  await assert.rejects(claude('x', { run: fakeSpawn(1, '', 'not logged in').run }), /claude exited 1 : not logged in/);
  const failed = JSON.stringify({ type: 'result', is_error: true, result: 'Usage limit reached' }) + '\n';
  await assert.rejects(claude('x', { run: fakeSpawn(0, failed).run }), /claude failed : Usage limit reached/);
});

test('pickHn : recent, open enough, with traction, not mine, not done ; HN URL and id', () => {
  const hit = (over) => ({ objectID: '1', title: 'x', story_text: null, author: 'pg', points: 10, num_comments: 3, created_at_i: NOW / 1000 - 3600, ...over });
  const json = { hits: [
    hit({ objectID: '1', title: 'Show HN: a devcontainer with a firewall', num_comments: 30 }),
    hit({ objectID: '2', title: 'Ask HN: how do you sandbox Claude Code?', story_text: '<p>I use docker &amp; hooks' }),
    hit({ objectID: '3', title: 'devcontainer', created_at_i: NOW / 1000 - 37 * 3600 }),
    hit({ objectID: '4', title: 'devcontainer', num_comments: 41 }),
    hit({ objectID: '5', title: 'devcontainer', points: 2 }),
    hit({ objectID: '6', title: 'devcontainer', author: 'meitogi' }),
    hit({ objectID: '7', title: 'devcontainer' }),
    hit({ objectID: '8', title: 'A new font' }),
  ] };
  const rows = pickHn(json, NOW, { hn7: NOW }, 'meitogi');
  assert.deepEqual(rows.map((r) => r.id), ['hn2', 'hn1']);
  assert.deepEqual(rows[0], { id: 'hn2', sub: 'HN', title: 'Ask HN: how do you sandbox Claude Code?', url: 'https://news.ycombinator.com/item?id=2', age: 3600, comments: 3, score: 4 + 2 + 1 + 2 + 2, topics: ['sandbox', 'claude-code'] });
});

test('text : HN HTML to plain text', () => {
  assert.equal(text('Use <i>this</i>:<p>a &gt; b &amp;&amp; c &#x27;d&#x27; &quot;e&quot; <a href="https:&#x2F;&#x2F;x.io">https:&#x2F;&#x2F;x.io</a>'), "Use this:\n\na > b && c 'd' \"e\" https://x.io");
});

test('threadOfHn : title, link and text, first comments as plain text, capped', () => {
  const item = { id: 9, title: 'Show HN: X', url: 'https://x.io', text: null, children: [
    { author: 'a', text: 'First <i>one</i>' }, { author: null, text: null }, { author: 'b', text: 'y'.repeat(2000) }, { author: 'c', text: 'third' },
  ] };
  assert.deepEqual(threadOfHn(item, 2), { site: 'hn', sub: 'HN', title: 'Show HN: X', body: 'Link: https://x.io', url: 'https://news.ycombinator.com/item?id=9', comments: [{ author: 'a', score: null, body: 'First one' }, { author: 'b', score: null, body: 'y'.repeat(1500) }] });
  assert.equal(threadOfHn({ ...item, url: null, text: 'Ask <i>text</i>' }).body, 'Ask text');
});

test('thread : HN has no subreddit, no u/ and no points', () => {
  assert.equal(thread({ site: 'hn', sub: 'HN', title: 'T', body: 'B', url: 'U', comments: [{ author: 'a', score: null, body: 'C' }] }), 'Hacker News — U\n\nTitle: T\n\nB\n\nTop comments:\n\na:\nC');
});
