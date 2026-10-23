import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refresh, WARN_DAYS } from '../scripts/refresh.mjs';
import { setSecret } from '../scripts/wizard.mjs';
import { fakeFetch } from './double.mjs';

const NOW = Date.parse('2026-10-23T06:23:00Z');
const DAY = 86400e3;

// A `gh` on PATH that records its arguments and what it read on stdin.
async function fakeGh(exit = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'megaphone-gh-'));
  await writeFile(join(dir, 'gh'), `#!/bin/sh\nprintf '%s' "$*" > "$GH_LOG.argv"\ncat > "$GH_LOG.stdin"\n[ "$exit" = "" ]\nexit ${exit}\n`);
  await chmod(join(dir, 'gh'), 0o755);
  const env = { PATH: `${dir}:${process.env.PATH}`, GH_LOG: join(dir, 'log'), GH_TOKEN: 'gh-pat' };
  const read = async (what) => readFile(`${env.GH_LOG}.${what}`, 'utf8');
  return { dir, env, read };
}

test('setSecret : the value travels on stdin, never in the arguments', async () => {
  const { dir, env, read } = await fakeGh();
  try {
    await setSecret('THREADS_TOKEN', 'new-tok\nwith newline', { repo: 'meitogi/megaphone', env });
    assert.equal(await read('argv'), 'secret set THREADS_TOKEN -R meitogi/megaphone');
    assert.equal(await read('stdin'), 'new-tok\nwith newline');
    await setSecret('X', 'v', { env });
    assert.equal(await read('argv'), 'secret set X');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh : Threads token refreshed through th_refresh_token, masked, then set with gh ; LinkedIn far from expiry', async () => {
  const { dir, env, read } = await fakeGh();
  const { f, calls } = fakeFetch(() => Response.json({ access_token: 'new-th-tok', token_type: 'bearer', expires_in: 5183944 }));
  const lines = [];
  const masked = [];
  try {
    const failed = await refresh({
      env: { ...env, THREADS_TOKEN: 'old-th-tok', LINKEDIN_TOKEN: 'li', LINKEDIN_EXPIRES: '2026-12-22', GITHUB_REPOSITORY: 'meitogi/megaphone' },
      fetch: f, now: NOW, log: (l) => lines.push(l), mask: (t) => masked.push(t),
    });
    assert.equal(failed, 0);
    assert.equal(calls.length, 1);
    const u = new URL(calls[0].url);
    assert.equal(calls[0].method, 'GET');
    assert.equal(`${u.origin}${u.pathname}`, 'https://graph.threads.com/refresh_access_token');
    assert.deepEqual(Object.fromEntries(u.searchParams), { grant_type: 'th_refresh_token', access_token: 'old-th-tok' });
    assert.deepEqual(masked, ['new-th-tok']);
    assert.equal(await read('argv'), 'secret set THREADS_TOKEN -R meitogi/megaphone');
    assert.equal(await read('stdin'), 'new-th-tok');
    assert.deepEqual(lines, ['threads : token refreshed, valid 60 days', 'linkedin : token expires 2026-12-22, 59 days left']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh : a refused refresh fails without leaking the token ; gh failing fails too', async () => {
  const { dir, env } = await fakeGh(1);
  const lines = [];
  try {
    const bad = fakeFetch(() => Response.json({ error: { message: 'Error validating access token old-th-tok', type: 'OAuthException', code: 190 } }, { status: 400 }));
    assert.equal(await refresh({ env: { ...env, THREADS_TOKEN: 'old-th-tok' }, fetch: bad.f, now: NOW, log: (l) => lines.push(l) }), 1);
    assert.deepEqual(lines, ['threads : threads refresh : HTTP 400 Error validating access token ***', 'linkedin : not configured, skipped']);
    const ok = fakeFetch(() => Response.json({ access_token: 'n', expires_in: 5184000 }));
    lines.length = 0;
    assert.equal(await refresh({ env: { ...env, THREADS_TOKEN: 'old-th-tok' }, fetch: ok.f, now: NOW, log: (l) => lines.push(l) }), 1);
    assert.match(lines[0], /^threads : gh secret set THREADS_TOKEN : exit 1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh : LinkedIn within ten days, or with an unknown expiry, fails with the instruction ; nothing set → skipped', async () => {
  const { f, calls } = fakeFetch(() => new Response('?', { status: 500 }));
  const lines = [];
  const at = (expires) => refresh({ env: { LINKEDIN_TOKEN: 'li', LINKEDIN_EXPIRES: expires }, fetch: f, now: NOW, log: (l) => lines.push(l) });
  // Days are whole days left, floored : a date within the warning window fails.
  assert.equal(await at(new Date(NOW + WARN_DAYS * DAY).toISOString().slice(0, 10)), 1);
  assert.match(lines.at(-1), /^linkedin : token expires 2026-11-02 \(9 days\) : run npm run linkedin:auth$/);
  assert.equal(await at('2026-11-03'), 1);
  assert.match(lines.at(-1), /^linkedin : token expires 2026-11-03 \(10 days\) : run npm run linkedin:auth$/);
  assert.equal(await at('2026-10-20'), 1);
  assert.match(lines.at(-1), /^linkedin : token expires 2026-10-20 \(-4 days\) : run npm run linkedin:auth$/);
  assert.equal(await at('2026-11-05'), 0);
  assert.match(lines.at(-1), /^linkedin : token expires 2026-11-05, 12 days left$/);
  assert.equal(await at(undefined), 1);
  assert.equal(lines.at(-1), 'linkedin : LINKEDIN_EXPIRES is not set, expiry unknown : run npm run linkedin:auth');
  assert.equal(await at('soon'), 1);
  lines.length = 0;
  assert.equal(await refresh({ env: {}, fetch: f, now: NOW, log: (l) => lines.push(l) }), 0);
  assert.deepEqual(lines, ['threads : not configured, skipped', 'linkedin : not configured, skipped']);
  assert.equal(calls.length, 0);
});
