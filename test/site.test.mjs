import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { site, guard } from '../scripts/site.mjs';

async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'megaphone-site-'));
  await mkdir(join(root, 'lib'));
  await mkdir(join(root, 'posts'));
  await writeFile(join(root, 'index.html'), '<h1>page</h1>');
  await writeFile(join(root, 'lib', 'post.mjs'), 'export {};');
  await writeFile(join(root, 'lib', 'publish.mjs'), 'export {};');
  await writeFile(join(root, 'posts', 'draft.md'), '---\nstatus: draft\n---\nsecret plans');
  await writeFile(join(root, '.env'), 'DEVTO_API_KEY=k');
  await writeFile(join(root, 'README.md'), '# r');
  return root;
}

async function files(dir, rel = '') {
  const out = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await files(dir, p)));
    else out.push(p);
  }
  return out.sort();
}

test('site : index.html and lib/*.mjs only — no posts/, no .env, no README', async () => {
  const root = await tree();
  try {
    assert.deepEqual(await site({ root }), ['index.html', 'lib/post.mjs', 'lib/publish.mjs']);
    assert.deepEqual(await files(join(root, 'site')), ['index.html', 'lib/post.mjs', 'lib/publish.mjs']);
    // A rebuild starts clean : a leftover in site/ does not survive.
    await writeFile(join(root, 'site', 'stale.txt'), 'x');
    await site({ root });
    assert.deepEqual(await files(join(root, 'site')), ['index.html', 'lib/post.mjs', 'lib/publish.mjs']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('site : refuses a symlink, .env, a stray file or a sub-directory in lib/, a linked index.html', async () => {
  const cases = [
    ['lib/.env', (root) => writeFile(join(root, 'lib', '.env'), 'K=v'), /lib\/\.env is not a module/],
    ['lib/notes.txt', (root) => writeFile(join(root, 'lib', 'notes.txt'), 'x'), /lib\/notes\.txt is not a module/],
    ['lib/posts/', (root) => mkdir(join(root, 'lib', 'posts.mjs')), /lib\/posts\.mjs is not a file/],
    ['lib/link.mjs', (root) => symlink(join(root, '.env'), join(root, 'lib', 'link.mjs')), /lib\/link\.mjs is a symlink/],
    ['index.html', async (root) => {
      await rm(join(root, 'index.html'));
      await symlink(join(root, 'README.md'), join(root, 'index.html'));
    }, /index\.html is a symlink/],
  ];
  for (const [what, make, err] of cases) {
    const root = await tree();
    try {
      await make(root);
      await assert.rejects(site({ root }), err, what);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('guard : the output must hold exactly the list, no symlink', async () => {
  const root = await tree();
  try {
    const out = join(root, 'out');
    await mkdir(join(out, 'lib'), { recursive: true });
    await writeFile(join(out, 'index.html'), 'x');
    await guard(out, ['index.html']);
    await mkdir(join(out, 'posts'));
    await writeFile(join(out, 'posts', 'draft.md'), 'x');
    await assert.rejects(guard(out, ['index.html']), /posts\/draft\.md is not on the allowlist/);
    await rm(join(out, 'posts'), { recursive: true });
    await symlink(join(root, '.env'), join(out, '.env'));
    await assert.rejects(guard(out, ['index.html', '.env']), /\.env is a symlink/);
    await rm(join(out, '.env'));
    await assert.rejects(guard(out, ['index.html', 'lib/post.mjs']), /2 files expected, 1 built/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
