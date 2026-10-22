// `npm run ui` : the page plus a tiny posts/ backend on localhost:4173.
//   GET /posts                 → [{ name }]
//   GET|PUT|DELETE /posts/<n>  → the Markdown file posts/<n>
// Everything else is served read-only from index.html and lib/.
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
const NAME = /^[\w.-]+\.md$/;

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function server({ root = ROOT, posts = join(root, 'posts') } = {}) {
  return createServer(async (req, res) => {
    const send = (code, data, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
    };
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path === '/posts' && req.method === 'GET') {
        const names = (await readdir(posts)).filter((n) => NAME.test(n)).sort();
        return send(200, JSON.stringify(names.map((name) => ({ name }))), 'application/json');
      }
      if (path.startsWith('/posts/')) {
        const name = path.slice(7);
        if (!NAME.test(name) || name.startsWith('.')) return send(400, 'bad name');
        const file = join(posts, name);
        if (req.method === 'GET') return send(200, await readFile(file), 'text/markdown; charset=utf-8');
        if (req.method === 'PUT') await writeFile(file, await body(req));
        else if (req.method === 'DELETE') await unlink(file);
        else return send(405, 'method not allowed');
        return send(204);
      }
      const rel = path === '/' ? 'index.html' : path.slice(1);
      if (req.method !== 'GET' || !(rel === 'index.html' || /^lib\/[\w.-]+\.mjs$/.test(rel))) return send(404, 'not found');
      return send(200, await readFile(join(root, rel)), TYPES[rel.slice(rel.lastIndexOf('.'))]);
    } catch (e) {
      send(e.code === 'ENOENT' ? 404 : 500, String(e.message));
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4173;
  server().listen(port, '127.0.0.1', () => console.log(`Megaphone on http://localhost:${port}`));
}
