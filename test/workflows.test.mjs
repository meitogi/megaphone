// The workflows cannot run here (no `act`) : they are read as text, and the
// scripts they call are tested for what the YAML relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFile(join(ROOT, '.github', 'workflows', name), 'utf8');
// The secrets publish.yml may use : docs/meitogi-comm/preparation.md § C of the monorepo.
const SECRETS = ['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD', 'MASTODON_URL', 'MASTODON_TOKEN', 'DEVTO_API_KEY', 'DISCORD_WEBHOOK',
  'THREADS_USER_ID', 'THREADS_TOKEN', 'FB_PAGE_ID', 'FB_PAGE_TOKEN', 'IG_USER_ID', 'LINKEDIN_PERSON_URN', 'LINKEDIN_TOKEN'];

// Every `run:` body, single-line or block.
function runs(yaml) {
  const out = [];
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] !== '|') {
      out.push(m[2]);
      continue;
    }
    const block = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > m[1].length)) block.push(lines[++i]);
    out.push(block.join('\n'));
  }
  return out;
}

test('publish.yml : hourly cron and dispatch, contents write, one run at a time', async () => {
  const y = await read('publish.yml');
  assert.match(y, /^ {2}schedule:\n {4}- cron: '17 \* \* \* \*'$/m);
  assert.match(y, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}post:\n[\s\S]*?^ {6}network:$/m);
  assert.match(y, /^permissions:\n {2}contents: write$/m);
  assert.match(y, /^concurrency:\n {2}group: publish\n {2}cancel-in-progress: false$/m);
  assert.match(y, /^ {6}- uses: actions\/setup-node@v7\n {8}with:\n {10}node-version: 24$/m);
  assert.match(y, /- name: Commit the results\n {8}if: always\(\)/);
});

test('publish.yml : no expression inside a run, inputs through env, secrets named as preparation.md C', async () => {
  const y = await read('publish.yml');
  const bodies = runs(y);
  assert.ok(bodies.length >= 3);
  for (const b of bodies) {
    assert.ok(!b.includes('inputs.'), b);
    assert.ok(!b.includes('${{'), b);
  }
  assert.match(y, /^ {10}POST: \$\{\{ inputs\.post \}\}$/m);
  assert.match(y, /^ {10}NETWORK: \$\{\{ inputs\.network \}\}$/m);
  const used = [...y.matchAll(/^\s+(\w+): \$\{\{ secrets\.(\w+) \}\}$/gm)];
  assert.deepEqual(used.map((m) => m[2]), ['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD', 'MASTODON_URL', 'MASTODON_TOKEN', 'DEVTO_API_KEY', 'DISCORD_WEBHOOK']);
  for (const [, env, secret] of used) {
    assert.equal(env, secret);
    assert.ok(SECRETS.includes(secret), secret);
  }
  assert.equal([...y.matchAll(/secrets\./g)].length, used.length);
  const publish = bodies.find((b) => b.includes('npm run due'));
  assert.match(publish, /node scripts\/publish\.mjs "posts\/\$POST" --network "\$NETWORK"/);
});

test('pages.yml : tests, the allowlisted site, the pages group', async () => {
  const y = await read('pages.yml');
  assert.match(y, /paths: \['index\.html', 'lib\/\*\*', 'scripts\/site\.mjs', '\.github\/workflows\/pages\.yml'\]/);
  assert.match(y, /^permissions:\n {2}contents: read$/m);
  assert.match(y, /^concurrency:\n {2}group: pages\n {2}cancel-in-progress: false$/m);
  assert.match(y, /- run: npm test\n {6}- run: node scripts\/site\.mjs\n {6}- uses: actions\/upload-pages-artifact@v5\n {8}with:\n {10}path: site\n/);
  assert.match(y, /uses: actions\/deploy-pages@v5/);
  for (const b of runs(y)) assert.ok(!b.includes('${{'), b);
});

const cli = promisify(execFile);
async function exit(...args) {
  try {
    await cli(process.execPath, [join(ROOT, 'scripts', 'publish.mjs'), ...args], { cwd: ROOT, env: { PATH: process.env.PATH } });
    return { code: 0, stderr: '' };
  } catch (e) {
    return { code: e.code, stderr: e.stderr };
  }
}

test('publish.mjs : refuses a bad post name or network before reading anything', async () => {
  for (const name of ['posts/../README.md', 'posts/x.txt', 'posts/a b.md', 'posts/$(id).md', 'posts/x.md;id']) {
    const r = await exit(name);
    assert.equal(r.code, 2, name);
    assert.match(r.stderr, /^bad post name /, name);
  }
  const r = await exit('posts/2026-11-03-x.md', '--network', 'devto;id');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^unknown network devto;id/);
  assert.equal((await exit()).code, 2);
});
