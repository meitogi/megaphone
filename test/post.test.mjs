import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize, render, slug, expandNetworks, AUTOMATED } from '../lib/post.mjs';

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
