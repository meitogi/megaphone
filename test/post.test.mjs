import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize, render, slug, expandNetworks, notDue, pending, intent, AUTOMATED } from '../lib/post.mjs';

const SAMPLE = `---
date: 2026-11-03T09:00+01:00
networks: all
image: img/sandbox-dns.png
alt: Terminal showing dnsmasq answering REFUSED to an unlisted domain
tags: [ClaudeCode, devcontainer, infosec]
link: https://github.com/meitogi/devcontainer-sandbox
status: draft
campaign: launch
---
Outbound DNS in Dev Sandbox answers REFUSED for anything not on the
allowlist. Not NXDOMAIN: REFUSED.

## long
The long variant, for LinkedIn and Facebook.

Repo : https://github.com/meitogi/devcontainer-sandbox
`;

const post = (meta, body = 'Hello.', long = null) => ({ meta, body, long });

test('parse reads every field, lists, body and long', () => {
  const p = parse(SAMPLE);
  assert.equal(p.meta.date, '2026-11-03T09:00+01:00');
  assert.equal(p.meta.networks, 'all');
  assert.deepEqual(p.meta.tags, ['ClaudeCode', 'devcontainer', 'infosec']);
  assert.equal(p.meta.link, 'https://github.com/meitogi/devcontainer-sandbox');
  assert.equal(p.meta.alt, 'Terminal showing dnsmasq answering REFUSED to an unlisted domain');
  assert.equal(p.meta.status, 'draft');
  assert.equal(p.body, 'Outbound DNS in Dev Sandbox answers REFUSED for anything not on the\nallowlist. Not NXDOMAIN: REFUSED.');
  assert.equal(p.long, 'The long variant, for LinkedIn and Facebook.\n\nRepo : https://github.com/meitogi/devcontainer-sandbox');
});

test('unknown keys survive parse → serialize', () => {
  const p = parse(SAMPLE);
  assert.equal(p.meta.campaign, 'launch');
  assert.match(serialize(p), /^campaign: launch$/m);
});

test('serialize → parse round-trips, and canonical text is stable', () => {
  assert.equal(serialize(parse(SAMPLE)), SAMPLE);
  const p = post({ date: '2026-11-03', networks: ['bluesky', 'x'], title: 'Show HN: a: colon', sub: 'ClaudeAI' }, 'Body', 'Long');
  assert.deepEqual(parse(serialize(p)), p);
});

test('brackets make a list only for networks and tags', () => {
  const p = parse('---\ntitle: [PSA] read this\nsub: [OC]\ntags: [a, b]\n---\nBody.\n');
  assert.equal(p.meta.title, '[PSA] read this');
  assert.equal(p.meta.sub, '[OC]');
  assert.deepEqual(p.meta.tags, ['a', 'b']);
});

test('a post without long has long null and no section', () => {
  const text = serialize(post({ status: 'draft' }, 'Only the body.'));
  assert.equal(text, '---\nstatus: draft\n---\nOnly the body.\n');
  assert.equal(parse(text).long, null);
});

test('CRLF input parses like LF', () => {
  assert.deepEqual(parse(SAMPLE.replace(/\n/g, '\r\n')), parse(SAMPLE));
});

test('networks: all expands to the automated networks, a list stays a list', () => {
  assert.deepEqual(expandNetworks('all'), AUTOMATED);
  assert.deepEqual(expandNetworks(undefined), AUTOMATED);
  assert.deepEqual(expandNetworks(['all']), AUTOMATED);
  assert.deepEqual(expandNetworks(['bluesky', 'x']), ['bluesky', 'x']);
  assert.deepEqual(expandNetworks('mastodon'), ['mastodon']);
  assert.ok(!AUTOMATED.includes('x') && !AUTOMATED.includes('devto'));
});

test('slug builds YYYY-MM-DD-slug.md', () => {
  assert.equal(slug('2026-11-03T09:00+01:00', 'Sandbox DNS : REFUSED, not NXDOMAIN !'), '2026-11-03-sandbox-dns-refused-not-nxdomain.md');
  assert.equal(slug('2026-11-03', 'Réglages élève'), '2026-11-03-reglages-eleve.md');
  assert.equal(slug('2026-11-03', ''), '2026-11-03-post.md');
  assert.ok(slug('2026-11-03', 'a'.repeat(200)).length <= 11 + 60 + 3);
});

const LINK = 'https://example.com/x';

test('bluesky : body plus link, no tags, 300 limit', () => {
  const r = render(post({ link: LINK, tags: ['a'] }, 'Hi.'), 'bluesky');
  assert.equal(r.text, `Hi.\n\n${LINK}`);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.limit, 300);
  const kept = render(post({ link: LINK }, `See ${LINK}.`), 'bluesky');
  assert.equal(kept.text, `See ${LINK}.`);
  const prefix = render(post({ link: LINK }, `See ${LINK}-extended now.`), 'bluesky');
  assert.equal(prefix.text, `See ${LINK}-extended now.\n\n${LINK}`);
});

test('bluesky : 301 characters warns, 300 does not', () => {
  assert.deepEqual(render(post({}, 'a'.repeat(300)), 'bluesky').warnings, []);
  const r = render(post({}, 'a'.repeat(301)), 'bluesky');
  assert.deepEqual(r.warnings, ['bluesky : 301 / 300 characters']);
  assert.equal(r.count, 301);
});

test('bluesky counts graphemes, not UTF-16 units', () => {
  assert.equal(render(post({}, '👩‍💻'.repeat(300)), 'bluesky').warnings.length, 0);
});

for (const network of ['mastodon', 'threads']) {
  test(`${network} : link and #tags appended, 500 limit`, () => {
    const r = render(post({ link: LINK, tags: ['ClaudeCode', '#infosec'] }, 'Hi.'), network);
    assert.equal(r.text, `Hi.\n\n${LINK}\n\n#ClaudeCode #infosec`);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(render(post({}, 'a'.repeat(501)), network).warnings, [`${network} : 501 / 500 characters`]);
  });
}

for (const network of ['linkedin', 'facebook']) {
  test(`${network} : long variant else body, link stripped`, () => {
    const withLong = render(post({ link: LINK }, 'Short.', `Long text.\n\nRepo : ${LINK}\n\nEnd.`), network);
    assert.equal(withLong.text, 'Long text.\n\nRepo :\n\nEnd.');
    const noLong = render(post({ link: LINK }, `Short ${LINK}`), network);
    assert.equal(noLong.text, 'Short');
    assert.equal(render(post({ link: LINK }, `See ${LINK}-2`), network).text, `See ${LINK}-2`);
    assert.deepEqual(noLong.warnings, []);
    assert.equal(noLong.limit, null);
  });
}

test('x : 280 limit, body untouched', () => {
  const r = render(post({ link: LINK, tags: ['a'] }, 'Hi.'), 'x');
  assert.equal(r.text, 'Hi.');
  assert.deepEqual(render(post({}, 'a'.repeat(281)), 'x').warnings, ['x : 281 / 280 characters']);
});

test('instagram : skipped without image, kept with one', () => {
  const r = render(post({}, 'Hi.'), 'instagram');
  assert.equal(r.skipped, true);
  assert.deepEqual(r.warnings, ['instagram : no image, skipped']);
  const ok = render(post({ image: 'img/a.png', alt: 'A cat' }, 'Hi.'), 'instagram');
  assert.equal(ok.skipped, false);
  assert.deepEqual(ok.warnings, []);
});

for (const network of ['discord', 'devto']) {
  test(`${network} : untouched`, () => {
    const body = `Hi ${LINK}\n\n${'a'.repeat(3000)}`;
    const r = render(post({ link: LINK, tags: ['a'] }, body), network);
    assert.equal(r.text, body);
    assert.deepEqual(r.warnings, []);
  });
}

test('image without alt warns on every network', () => {
  for (const n of ['bluesky', 'mastodon', 'linkedin', 'instagram', 'discord']) {
    assert.deepEqual(render(post({ image: 'img/a.png' }, 'Hi.'), n).warnings, ['image without alt text']);
  }
});

test('PurrPause guard-rail : forbidden words warn, named in text, tags or title', () => {
  const r = render(post({}, 'PurrPause is hidden and hard to disable.'), 'bluesky');
  assert.deepEqual(r.warnings, ['PurrPause : never « hidden »', 'PurrPause : never « hard to disable »']);
  const tagged = render(post({ tags: ['PurrPause'] }, 'Camouflaged as a service.'), 'mastodon');
  assert.deepEqual(tagged.warnings, ['PurrPause : never « camouflaged »']);
  assert.deepEqual(render(post({}, 'Hidden gem of a sandbox.'), 'bluesky').warnings, []);
  assert.deepEqual(render(post({}, 'PurrPause runs as a service.'), 'bluesky').warnings, []);
});

test('CTR guard-rail : gameplay gif or mp4 needs « bring your own disc »', () => {
  const warn = ['CTR gameplay media : say « bring your own NTSC-U disc, nothing is hosted »'];
  assert.deepEqual(render(post({ image: 'img/race.gif', alt: 'Race' }, 'CTR in a browser tab.'), 'bluesky').warnings, warn);
  assert.deepEqual(render(post({ image: 'img/race.mp4', alt: 'Race' }, 'Crash Team Racing, online.'), 'bluesky').warnings, warn);
  const ok = 'CTR in a browser tab. Bring your own NTSC-U disc, nothing is hosted.';
  assert.deepEqual(render(post({ image: 'img/race.gif', alt: 'Race' }, ok), 'bluesky').warnings, []);
  assert.deepEqual(render(post({ image: 'img/race.png', alt: 'Race' }, 'CTR in a browser tab.'), 'bluesky').warnings, []);
  assert.deepEqual(render(post({ image: 'img/x.gif', alt: 'X' }, 'An electric vector.'), 'bluesky').warnings, []);
});

// --- schedule -----------------------------------------------------------------------

test('notDue : ready with a past or present date is due ; everything else says why', () => {
  const now = Date.parse('2026-11-03T08:00:00Z');
  const at = (status, date) => notDue({ meta: { status, date } }, now);
  assert.equal(at('ready', '2026-11-03T09:00+01:00'), null);
  assert.equal(at('ready', '2026-11-02'), null);
  assert.equal(at('ready', '2026-11-03T09:01+01:00'), 'due 2026-11-03T09:01+01:00');
  assert.equal(at('draft', '2026-11-01'), 'status draft');
  assert.equal(at('published', '2026-11-01'), 'status published');
  assert.equal(at(undefined, '2026-11-01'), 'status unset');
  assert.equal(at('ready', undefined), 'no date');
  assert.equal(at('ready', 'next tuesday'), 'unparseable date next tuesday');
});

test('pending : the able networks without a success, `all` expanded', () => {
  const able = ['bluesky', 'mastodon', 'discord', 'devto'];
  const meta = { networks: ['bluesky', 'devto', 'x', 'threads'], bluesky: 'https://bsky.app/p/1', devto: 'failed 2026-11-03T08:00:00Z devto : HTTP 401' };
  assert.deepEqual(pending({ meta }, able), ['devto']);
  meta.devto = 'https://dev.to/a';
  assert.deepEqual(pending({ meta }, able), []);
  assert.deepEqual(pending({ meta: { networks: 'all', discord: 'ok 42' } }, able), ['bluesky', 'mastodon']);
  assert.deepEqual(pending({ meta: { networks: ['x', 'threads'] } }, able), []);
});

// --- intents --------------------------------------------------------------------------

const TRICKY = 'Fish & chips #1? Yes.\nNext line é 🐈 100% a=b';
const ILINK = 'https://a.io/p?x=1&y=2#frag';
const ipost = (meta = {}, body = TRICKY, long = null) => ({ meta: { link: ILINK, title: 'Title & #1? é 🐈', sub: 'r/ClaudeAI', ...meta }, body, long });
const decode = (url) => {
  const u = new URL(url);
  return { base: `${u.origin}${u.pathname}`, p: Object.fromEntries(new URLSearchParams(u.search)) };
};

test('intent x : the text in the URL, the link left for a reply', () => {
  const it = intent(ipost(), 'x');
  const { base, p } = decode(it.url);
  assert.equal(base, 'https://x.com/intent/post');
  assert.deepEqual(p, { text: TRICKY });
  assert.equal(it.copy, ILINK);
  assert.ok(!('copy' in intent(ipost({ link: undefined }), 'x')));
  assert.deepEqual(intent(ipost({}, '  '), 'x'), { blocked: 'No text' });
});

test('intent threads : the rendered text, link and tags included', () => {
  const post = ipost({ tags: ['oss'] });
  const { base, p } = decode(intent(post, 'threads').url);
  assert.equal(base, 'https://www.threads.com/intent/post');
  assert.deepEqual(p, { text: `${TRICKY}\n\n${ILINK}\n\n#oss` });
  assert.equal(p.text, render(post, 'threads').text);
  assert.deepEqual(intent(ipost({ link: undefined }, ''), 'threads'), { blocked: 'No text' });
});

test('intent linkedin : the long variant with the link, also offered as a copy', () => {
  const it = intent(ipost({}, TRICKY, `Long & #2 é\n${ILINK}`), 'linkedin');
  const { base, p } = decode(it.url);
  assert.equal(base, 'https://www.linkedin.com/feed/');
  assert.deepEqual(p, { shareActive: 'true', text: `Long & #2 é\n\n${ILINK}` });
  assert.equal(it.copy, p.text);
});

test('intent facebook : the link only, the text to paste', () => {
  const it = intent(ipost(), 'facebook');
  const { base, p } = decode(it.url);
  assert.equal(base, 'https://www.facebook.com/sharer/sharer.php');
  assert.deepEqual(p, { u: ILINK });
  assert.equal(it.copy, TRICKY);
  assert.deepEqual(intent(ipost({ link: undefined }), 'facebook'), { blocked: 'Needs a link' });
});

test('intent reddit : title, self text with the link, the sub without r/', () => {
  const { base, p } = decode(intent(ipost(), 'reddit').url);
  assert.equal(base, 'https://www.reddit.com/r/ClaudeAI/submit');
  assert.deepEqual(p, { title: 'Title & #1? é 🐈', selftext: 'true', text: `${TRICKY}\n\n${ILINK}` });
  assert.equal(decode(intent(ipost({ sub: '/r/vscode' }), 'reddit').url).base, 'https://www.reddit.com/r/vscode/submit');
  assert.deepEqual(intent(ipost({ title: undefined }), 'reddit'), { blocked: 'Needs a title' });
  assert.deepEqual(intent(ipost({ sub: undefined }), 'reddit'), { blocked: 'Needs a subreddit' });
  assert.deepEqual(intent(ipost({ sub: 'r/' }), 'reddit'), { blocked: 'Needs a subreddit' });
});

test('intent hn : link and title', () => {
  const { base, p } = decode(intent(ipost(), 'hn').url);
  assert.equal(base, 'https://news.ycombinator.com/submitlink');
  assert.deepEqual(p, { u: ILINK, t: 'Title & #1? é 🐈' });
  assert.deepEqual(intent(ipost({ link: undefined }), 'hn'), { blocked: 'Needs a link' });
  assert.deepEqual(intent(ipost({ title: undefined }), 'hn'), { blocked: 'Needs a title' });
  assert.deepEqual(intent(ipost(), 'bluesky'), { blocked: 'bluesky : no composer' });
});
