// ==UserScript==
// @name         Reddit Scout (Megaphone)
// @namespace    meitogi.megaphone
// @version      0.1.0
// @description  Lists the recent threads worth answering on your subreddits and drafts a reply through the local Megaphone server. Never posts anything.
// @match        https://www.reddit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      localhost
// @noframes
// ==/UserScript==

// Edit these to taste ; the script reloads with the page.
const SUBS = ['ClaudeAI', 'ClaudeCode', 'devcontainers', 'docker', 'emulation', 'WebAssembly', 'vscode'];
const MAX_AGE_H = 24;
const MAX_COMMENTS = 5;
const SHOWN = 15;
const DRAFT_URL = 'http://localhost:4173/reddit/draft';
// Keyword → weight, per theme. A title hit counts double.
const TOPICS = {
  sandbox: { devcontainer: 3, 'dev container': 3, 'devcontainer.json': 3, sandbox: 2, firewall: 2, egress: 2, dnsmasq: 3, 'network access': 2, 'dangerously-skip-permissions': 3, 'skip permissions': 2, yolo: 1, docker: 1, isolation: 1 },
  'claude-code': { 'claude code': 1, hook: 2, hooks: 2, 'settings.json': 2, permission: 2, permissions: 2, 'claude.md': 2, mcp: 1, subagent: 1, statusline: 2 },
  vscode: { 'vs code': 1, vscode: 1, extension: 1, 'remote-containers': 3, 'dev containers': 3 },
  'web-ports': { webassembly: 2, wasm: 2, emscripten: 3, webgl: 2, webgl2: 2, webrtc: 2, decomp: 3, decompilation: 3, ps1: 2, psx: 2, 'crash team': 3, ctr: 1 },
};
const QUESTION = /^(how|why|what|is|are|can|does|do|any|should|anyone)\b/;

const RX = {};
for (const topic in TOPICS) {
  const words = TOPICS[topic];
  for (const w in words) RX[w] = new RegExp(`(^|[^\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`);
}

// { score, topics } of one listing post ; 0 when no keyword matched.
function score(post) {
  const title = (post.title || '').toLowerCase();
  const body = (post.selftext || '').toLowerCase();
  let s = 0;
  const topics = [];
  for (const topic in TOPICS) {
    const words = TOPICS[topic];
    for (const w in words) {
      const rx = RX[w];
      const hit = rx.test(title) ? words[w] * 2 : rx.test(body) ? words[w] : 0;
      if (!hit) continue;
      s += hit;
      if (!topics.includes(topic)) topics.push(topic);
    }
  }
  if (!s) return { score: 0, topics };
  if (title.includes('?') || QUESTION.test(title) || /help|question/i.test(post.link_flair_text || '')) s += 2;
  return { score: s, topics };
}

// The posts worth a reply, best first : recent, few comments, open, not mine, not done.
function pick(listing, now, done = {}, me = '') {
  const out = [];
  for (const child of listing.data.children) {
    const p = child.data;
    if (now / 1000 - p.created_utc > MAX_AGE_H * 3600) continue;
    if (p.num_comments > MAX_COMMENTS || p.locked || p.stickied || done[p.id]) continue;
    if (me && p.author === me) continue;
    const r = score(p);
    if (r.score) out.push({ id: p.id, sub: p.subreddit, title: p.title, url: `https://www.reddit.com${p.permalink}`, age: now / 1000 - p.created_utc, comments: p.num_comments, score: r.score, topics: r.topics });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, SHOWN);
}

// What POST /reddit/draft takes, from a thread's .json ([post listing, comment listing]).
function threadOf(json, keep = 8) {
  const p = json[0].data.children[0].data;
  const comments = [];
  for (const c of json[1].data.children) {
    if (comments.length === keep) break;
    const d = c.data;
    if (c.kind !== 't1' || d.stickied || !d.body) continue;
    comments.push({ author: d.author, score: d.score, body: d.body.slice(0, 1500) });
  }
  return { sub: p.subreddit, title: p.title, body: (p.selftext || '').slice(0, 6000), url: `https://www.reddit.com${p.permalink}`, comments };
}

// ── Page side ───────────────────────────────────────────────────────────

const DAY = 86400e3;

function el(tag, style, text) {
  const e = document.createElement(tag);
  if (style) e.style.cssText = style;
  if (text !== undefined) e.textContent = text;
  return e;
}

const BTN = 'background:#2A303A;color:#D8DEE6;border:1px solid #3A4250;border-radius:6px;padding:4px 10px;font:13px system-ui;cursor:pointer';

function loadDone(now) {
  const done = GM_getValue('done', {});
  for (const id in done) if (now - done[id] > 7 * DAY) delete done[id];
  return done;
}

async function getJson(path) {
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

function main() {
  const bar = el('div', 'position:fixed;left:16px;bottom:16px;z-index:2147483646;display:flex;gap:6px');
  const panel = el('div', 'position:fixed;left:16px;bottom:56px;z-index:2147483646;width:min(560px,calc(100vw - 32px));max-height:70vh;overflow:auto;background:#161A20;color:#D8DEE6;border:1px solid #3A4250;border-radius:8px;padding:12px;font:13px/1.45 system-ui;display:none');
  const scout = el('button', BTN, 'Scout');
  const draftBtn = el('button', BTN, 'Brouillon');
  bar.append(scout, draftBtn);
  document.body.append(bar, panel);

  const show = (...nodes) => {
    panel.replaceChildren(...nodes);
    panel.style.display = 'block';
  };
  const close = el('button', `${BTN};float:right`, 'Fermer');
  close.onclick = () => (panel.style.display = 'none');

  scout.onclick = async () => {
    show(el('div', '', 'Recherche…'));
    try {
      const now = Date.now();
      const done = loadDone(now);
      let me = '';
      try {
        me = (await getJson('/api/me.json')).data?.name || '';
      } catch {}
      const listing = await getJson(`/r/${SUBS.join('+')}/new.json?limit=100&raw_json=1`);
      const rows = pick(listing, now, done, me);
      const list = el('div');
      for (const r of rows) {
        const row = el('div', 'padding:8px 0;border-top:1px solid #2A303A');
        const a = el('a', 'color:#D8DEE6;font-weight:600;text-decoration:none', r.title);
        a.href = r.url;
        const meta = el('div', 'color:#8A94A3', `${r.score} pts · r/${r.sub} · ${Math.round(r.age / 3600)} h · ${r.comments} comm. · ${r.topics.join(', ')}`);
        const mark = el('button', `${BTN};margin-top:4px;padding:2px 8px`, 'fait');
        mark.onclick = () => {
          done[r.id] = Date.now();
          GM_setValue('done', done);
          row.remove();
        };
        row.append(a, meta, mark);
        list.append(row);
      }
      if (!rows.length) list.append(el('div', 'color:#8A94A3', `Rien à moins de ${MAX_AGE_H} h sur tes sujets. Repasse plus tard.`));
      show(close, el('div', 'font-weight:600;margin-bottom:6px', `Scout — ${rows.length} fil(s)`), list);
    } catch (e) {
      show(close, el('div', 'color:#E8A0A0', `Lecture de Reddit impossible : ${e.message}`));
    }
  };

  draftBtn.onclick = async () => {
    const m = /^(\/r\/[^/]+\/comments\/[a-z0-9]+)/i.exec(location.pathname);
    if (!m) return show(close, el('div', '', 'Ouvre un fil (une page /comments/…) puis Brouillon.'));
    show(el('div', '', 'Lecture du fil…'));
    let t;
    try {
      t = threadOf(await getJson(`${m[1]}.json?raw_json=1&limit=20&sort=top`));
    } catch (e) {
      return show(close, el('div', 'color:#E8A0A0', `Lecture du fil impossible : ${e.message}`));
    }
    show(el('div', '', 'Claude rédige… (10 à 60 s)'));
    GM_xmlhttpRequest({
      method: 'POST',
      url: DRAFT_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(t),
      timeout: 180e3,
      onload: (res) => {
        if (res.status !== 200) return show(close, el('div', 'color:#E8A0A0', `Serveur local : HTTP ${res.status} — ${res.responseText}`));
        const text = el('textarea', 'width:100%;min-height:200px;margin-top:8px;background:#0F1217;color:#D8DEE6;border:1px solid #3A4250;border-radius:6px;padding:8px;font:13px/1.45 system-ui;box-sizing:border-box');
        text.value = JSON.parse(res.responseText).draft;
        const copy = el('button', BTN, 'Copier');
        copy.onclick = () => {
          GM_setClipboard(text.value, 'text');
          copy.textContent = 'Copié';
        };
        show(close, el('div', 'font-weight:600', 'Brouillon'), el('div', 'color:#8A94A3', 'Relis, mets-le à ta façon, poste toi-même.'), text, copy);
      },
      onerror: () => show(close, el('div', 'color:#E8A0A0', 'Serveur local injoignable : lance « npm run ui » dans apps/megaphone et forwarde le port 4173 (VS Code, panneau Ports).')),
      ontimeout: () => show(close, el('div', 'color:#E8A0A0', 'Pas de réponse en 3 min : regarde le terminal de « npm run ui ».')),
    });
  };
}

if (typeof document !== 'undefined') main();
