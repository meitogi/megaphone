// `npm run ui` : the page plus a tiny posts/ backend on localhost:4173.
//   GET /posts                 → [{ name }]
//   GET|PUT|DELETE /posts/<n>  → the Markdown file posts/<n>
//   GET /posts/img/<n>         → an image of posts/img/, read-only
//   POST /draft                → { analysis, draft, usage } : a Reddit or HN reply drafted by `claude -p` for Scout
// Everything else is served read-only from index.html and lib/.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
const NAME = /^[\w.-]+\.md$/;
const IMAGES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const IMAGE = /^[\w-][\w.-]*\.(png|jpe?g|gif|webp)$/i;
const MAX_THREAD = 64 * 1024;
// Scout's site → the draft prompt in prompts/.
const PROMPTS = { reddit: 'reddit-reply.md', hn: 'hn-reply.md' };

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// The thread as the user message of the draft : what the prompt says comes in.
export function thread({ site, sub, title, body, url, comments = [] }) {
  const hn = site === 'hn';
  const lines = [`${hn ? 'Hacker News' : `r/${sub}`} — ${url}`, '', `Title: ${title}`, '', body || '(no body)', '', 'Top comments:'];
  if (!comments.length) lines.push('(none yet)');
  for (const c of comments) lines.push('', hn ? `${c.author}:` : `u/${c.author} (${c.score} points):`, c.body);
  return lines.join('\n');
}

// The model's answer, « ANALYSE: … RÉPONSE: … » per the prompts ; without the markers, all of it is the draft.
export function parse(text) {
  const m = /^\s*ANALYSE\s*:\s*([\s\S]*?)\n\s*RÉPONSE\s*:\s*([\s\S]*)$/.exec(text);
  return m ? { analysis: m[1].trim(), draft: m[2].trim() } : { analysis: '', draft: text.trim() };
}

// `claude -p` without tools on the Max subscription : the API key is dropped from the env, and
// --safe-mode keeps the user's CLAUDE.md, hooks and skills out of the draft (auth unchanged).
// stream-json is read for its result line and its rate_limit_event : the subscription windows'
// utilization only comes there. usage = { in, out } tokens, plus { fiveHour, sevenDay } in %.
export function claude(input, { root = ROOT, prompt = 'reddit-reply.md', run = spawn } = {}) {
  const args = ['-p', '--safe-mode', '--tools', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--system-prompt-file', join(root, 'prompts', prompt)];
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    const child = run('claude', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code} : ${err.trim() || out.trim()}`));
      let result = null;
      const usage = {};
      for (const line of out.split('\n')) {
        if (!line.startsWith('{')) continue;
        const m = JSON.parse(line);
        if (m.type === 'result') result = m;
        else if (m.type === 'rate_limit_event') {
          const w = m.rate_limit_info.unifiedWindows || {};
          if (w.five_hour) usage.fiveHour = Math.round(w.five_hour.utilization * 100);
          if (w.seven_day) usage.sevenDay = Math.round(w.seven_day.utilization * 100);
        }
      }
      if (!result || result.is_error) return reject(new Error(`claude failed : ${result ? result.result : err.trim() || 'no result line'}`));
      const u = result.usage;
      usage.in = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
      usage.out = u.output_tokens;
      resolve({ ...parse(result.result), usage });
    });
    child.stdin.end(input);
  });
}

export function server({ root = ROOT, posts = join(root, 'posts'), draft = (input, prompt) => claude(input, { root, prompt }) } = {}) {
  return createServer(async (req, res) => {
    const send = (code, data, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
    };
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path === '/draft') {
        if (req.method !== 'POST') return send(405, 'method not allowed');
        const text = await body(req);
        if (text.length > MAX_THREAD) return send(413, 'thread too large');
        const t = JSON.parse(text);
        if (!t.title || !t.sub || !PROMPTS[t.site]) return send(400, 'site (reddit or hn), sub and title required');
        return send(200, JSON.stringify(await draft(thread(t), PROMPTS[t.site])), 'application/json');
      }
      if (path === '/posts' && req.method === 'GET') {
        const names = (await readdir(posts)).filter((n) => NAME.test(n)).sort();
        return send(200, JSON.stringify(names.map((name) => ({ name }))), 'application/json');
      }
      if (path.startsWith('/posts/img/')) {
        const name = path.slice(11);
        const m = IMAGE.exec(name);
        if (!m) return send(400, 'bad name');
        if (req.method !== 'GET') return send(405, 'method not allowed');
        return send(200, await readFile(join(posts, 'img', name)), IMAGES[m[1].toLowerCase()]);
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
