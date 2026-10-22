import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server } from '../scripts/ui.mjs';
import { local, github } from '../lib/backends.mjs';

let dir, srv, base;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'megaphone-'));
  await mkdir(join(dir, 'posts'));
  await mkdir(join(dir, 'lib'));
  await writeFile(join(dir, 'index.html'), '<h1>page</h1>');
  await writeFile(join(dir, 'lib', 'post.mjs'), 'export {};');
  await writeFile(join(dir, 'secret.txt'), 'nope');
  srv = server({ root: dir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  await new Promise((r) => srv.close(r));
  await rm(dir, { recursive: true, force: true });
});

test('local backend : write, list, read, overwrite, remove on posts/', async () => {
  const b = local(base);
  assert.deepEqual(await b.list(), []);
  const text = '---\nstatus: draft\n---\nHéllo 👋\n';
  await b.write('2026-11-03-hello.md', text);
  assert.equal(await readFile(join(dir, 'posts', '2026-11-03-hello.md'), 'utf8'), text);
  assert.deepEqual(await b.list(), [{ name: '2026-11-03-hello.md' }]);
  assert.equal((await b.read('2026-11-03-hello.md')).text, text);
  await b.write('2026-11-03-hello.md', 'v2');
  assert.equal((await b.read('2026-11-03-hello.md')).text, 'v2');
  await b.remove('2026-11-03-hello.md');
  assert.deepEqual(await readdir(join(dir, 'posts')), []);
  await assert.rejects(b.read('2026-11-03-hello.md'), /HTTP 404/);
});

test('local server : list ignores non-Markdown files', async () => {
  await writeFile(join(dir, 'posts', '.gitkeep'), '');
  assert.deepEqual(await local(base).list(), []);
});

test('local server : serves the page and lib/, nothing else', async () => {
  assert.equal(await (await fetch(`${base}/`)).text(), '<h1>page</h1>');
  const lib = await fetch(`${base}/lib/post.mjs`);
  assert.match(lib.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/secret.txt`)).status, 404);
  assert.equal((await fetch(`${base}/lib/../secret.txt`)).status, 404);
});

test('local server : refuses names outside posts/', async () => {
  for (const name of ['..%2Fsecret.md', '.hidden.md', 'a%2Fb.md', 'notes.txt']) {
    assert.equal((await fetch(`${base}/posts/${name}`, { method: 'PUT', body: 'x' })).status, 400, name);
  }
});

// A recorded double of the contents API : only what `fetch` returns.
function fakeGithub() {
  const calls = [];
  const files = {};
  const f = async (url, init) => {
    calls.push({ url, init });
    const name = decodeURIComponent(url.split('/contents/posts')[1].slice(1));
    const method = init.method || 'GET';
    if (!name) return Response.json(Object.keys(files).map((n) => ({ type: 'file', name: n, sha: files[n].sha })).concat({ type: 'file', name: '.gitkeep', sha: 'k' }));
    if (method === 'GET') {
      if (!files[name]) return new Response('Not Found', { status: 404 });
      const b64 = files[name].content.replace(/(.{60})/g, '$1\n');
      return Response.json({ content: b64, sha: files[name].sha });
    }
    if (method === 'PUT') {
      const body = JSON.parse(init.body);
      if (files[name] && body.sha !== files[name].sha) return new Response('conflict', { status: 409 });
      files[name] = { content: body.content, sha: `sha${calls.length}` };
      return Response.json({ content: { sha: files[name].sha } });
    }
    delete files[name];
    return Response.json({});
  };
  return { f, calls, files };
}

test('github backend : headers, base64 UTF-8 round-trip, sha on update and delete', async () => {
  const { f, calls, files } = fakeGithub();
  const b = github({ owner: 'meitogi', repo: 'megaphone', token: 'tok', fetch: f });
  const text = `---\nstatus: draft\n---\nRéglages 👋 ${'x'.repeat(100)}\n`;
  const { sha } = await b.write('a.md', text);
  assert.equal(calls[0].url, 'https://api.github.com/repos/meitogi/megaphone/contents/posts/a.md');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].init.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(JSON.parse(calls[0].init.body).sha, undefined);
  assert.deepEqual(await b.list(), [{ name: 'a.md', sha }]);
  const read = await b.read('a.md');
  assert.equal(read.text, text);
  const { sha: sha2 } = await b.write('a.md', 'v2', read.sha);
  assert.equal(JSON.parse(calls.at(-1).init.body).sha, sha);
  await assert.rejects(b.write('a.md', 'v3', sha), /HTTP 409/);
  await b.remove('a.md', sha2);
  assert.equal(JSON.parse(calls.at(-1).init.body).sha, sha2);
  assert.deepEqual(files, {});
});
