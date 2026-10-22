// Where the posts live. Both backends expose the same four calls :
//   list()                   → [{ name, sha }]
//   read(name)               → { text, sha }
//   write(name, text, sha)   → { sha }   (sha omitted for a new file)
//   remove(name, sha)
//   bytes(path)              → Uint8Array of posts/<path>, an image (`img/<name>`)
// The GitHub backend adds dispatch(inputs), which runs publish.yml on main.
// `sha` is the GitHub blob sha ; the local backend ignores it.

async function check(res, what) {
  if (!res.ok) throw new Error(`${what} : HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  return res;
}

// The local server of `npm run ui`, on the page's own origin by default.
export function local(base = '') {
  const url = (name) => `${base}/posts/${encodeURIComponent(name)}`;
  return {
    async list() {
      const res = await check(await fetch(`${base}/posts`, { cache: 'no-store' }), 'list');
      return res.json();
    },
    async read(name) {
      const res = await check(await fetch(url(name), { cache: 'no-store' }), `read ${name}`);
      return { text: await res.text(), sha: null };
    },
    async write(name, text) {
      await check(await fetch(url(name), { method: 'PUT', body: text }), `write ${name}`);
      return { sha: null };
    },
    async remove(name) {
      await check(await fetch(url(name), { method: 'DELETE' }), `remove ${name}`);
    },
    async bytes(path) {
      const res = await check(await fetch(`${base}/posts/${path.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' }), `read ${path}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// The GitHub contents API, with a fine-grained PAT (Contents read/write, and
// Actions read/write for dispatch).
export function github({ owner, repo, token, fetch: f = fetch }) {
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const root = `${api}/contents/posts`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const call = async (what, path, init = {}) =>
    check(await f(path, { cache: 'no-store', ...init, headers: { ...headers, ...init.headers } }), what);
  return {
    async list() {
      const items = await (await call('list', root)).json();
      return items.filter((i) => i.type === 'file' && i.name.endsWith('.md')).map((i) => ({ name: i.name, sha: i.sha }));
    },
    async read(name) {
      const item = await (await call(`read ${name}`, `${root}/${encodeURIComponent(name)}`)).json();
      return { text: fromBase64(item.content), sha: item.sha };
    },
    async write(name, text, sha) {
      const body = { message: `post: ${sha ? 'update' : 'add'} ${name}`, content: toBase64(text) };
      if (sha) body.sha = sha;
      const res = await call(`write ${name}`, `${root}/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      return { sha: (await res.json()).content.sha };
    },
    async remove(name, sha) {
      await call(`remove ${name}`, `${root}/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        body: JSON.stringify({ message: `post: remove ${name}`, sha }),
      });
    },
    // The raw media type : the JSON `content` field is empty above 1 MB.
    async bytes(path) {
      const res = await call(`read ${path}`, `${root}/${path.split('/').map(encodeURIComponent).join('/')}`, {
        headers: { Accept: 'application/vnd.github.raw+json' },
      });
      return new Uint8Array(await res.arrayBuffer());
    },
    // workflow_dispatch of publish.yml on main ; GitHub answers 204, no run id.
    async dispatch(inputs) {
      await call('dispatch', `${api}/actions/workflows/publish.yml/dispatches`, {
        method: 'POST',
        body: JSON.stringify({ ref: 'main', inputs }),
      });
    },
  };
}
