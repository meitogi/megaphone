import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consentUrl, parseCallback, exchange, person, SCOPES } from '../scripts/linkedin-auth.mjs';
import { threadsLongToken, threadsUser, fbLongToken, fbPages, FB_PERMISSIONS } from '../scripts/meta-auth.mjs';
import { upsertEnv, saveEnv, pagesUrl } from '../scripts/wizard.mjs';
import { fakeFetch } from './double.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-10-23T10:00:00Z');
const APP = { clientId: 'cid-1', clientSecret: 'csecret-1', redirectUri: 'https://meitogi.github.io/megaphone/' };

test('linkedin consent URL : every field, decoded', () => {
  const u = new URL(consentUrl({ ...APP, state: 'st-42' }));
  assert.equal(`${u.origin}${u.pathname}`, 'https://www.linkedin.com/oauth/v2/authorization');
  assert.deepEqual(Object.fromEntries(u.searchParams), { response_type: 'code', client_id: 'cid-1', redirect_uri: APP.redirectUri, state: 'st-42', scope: 'openid profile w_member_social' });
  assert.equal(SCOPES, 'openid profile w_member_social');
});

test('linkedin callback : the code once the state matches ; refusals, mismatches and junk are named', () => {
  assert.equal(parseCallback(`${APP.redirectUri}?code=AQT-code&state=st-42`, 'st-42'), 'AQT-code');
  assert.equal(parseCallback(`  ${APP.redirectUri}?state=st-42&code=x%2Fy  \n`, 'st-42'), 'x/y');
  assert.throws(() => parseCallback(`${APP.redirectUri}?code=AQT&state=other`, 'st-42'), /state mismatch/);
  assert.throws(() => parseCallback(`${APP.redirectUri}?error=user_cancelled_login&error_description=The+member+declined&state=st-42`, 'st-42'), /LinkedIn refused : user_cancelled_login — The member declined/);
  assert.throws(() => parseCallback(`${APP.redirectUri}?state=st-42`, 'st-42'), /no code/);
  assert.throws(() => parseCallback('AQT-code', 'st-42'), /not an address/);
});

test('linkedin exchange and userinfo : form-encoded token request, 60-day expiry date, person URN from sub', async () => {
  const { f, calls } = fakeFetch((req) => (req.url.includes('accessToken')
    ? Response.json({ access_token: 'li-tok', expires_in: 5184000, scope: 'openid,profile,w_member_social', token_type: 'Bearer' })
    : Response.json({ sub: 'A8xe03Qt10', name: 'Meitogi' })));
  const { token, expires } = await exchange({ code: 'AQT-code', ...APP, fetch: f, now: NOW });
  assert.equal(token, 'li-tok');
  assert.equal(expires, '2026-12-22');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://www.linkedin.com/oauth/v2/accessToken');
  assert.match(calls[0].headers.get('content-type'), /^application\/x-www-form-urlencoded/);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(await calls[0].text())), { grant_type: 'authorization_code', code: 'AQT-code', client_id: 'cid-1', client_secret: 'csecret-1', redirect_uri: APP.redirectUri });
  assert.equal(await person(token, f), 'urn:li:person:A8xe03Qt10');
  assert.equal(calls[1].url, 'https://api.linkedin.com/v2/userinfo');
  assert.equal(calls[1].headers.get('authorization'), 'Bearer li-tok');
  const bad = fakeFetch(() => Response.json({ error: 'invalid_request', error_description: 'A required parameter "code" is missing' }, { status: 400 }));
  await assert.rejects(exchange({ code: 'x', ...APP, fetch: bad.f }), /linkedin token : HTTP 400 A required parameter "code" is missing/);
});

test('meta exchanges : th_exchange_token and /me, fb_exchange_token and the pages with their Instagram account', async () => {
  const { f, calls } = fakeFetch((req) => {
    const u = new URL(req.url);
    if (u.host === 'graph.threads.com' && u.pathname === '/access_token') return Response.json({ access_token: 'th-long', token_type: 'bearer', expires_in: 5183944 });
    if (u.host === 'graph.threads.com' && u.pathname === '/v1.0/me') return Response.json({ id: '17841400', username: 'meitogi' });
    if (u.pathname === '/v26.0/oauth/access_token') return Response.json({ access_token: 'fb-long', token_type: 'bearer', expires_in: 5183944 });
    if (u.pathname === '/v26.0/me/accounts') return Response.json({ data: [{ id: '1234', name: 'Meitogi', access_token: 'page-tok', instagram_business_account: { id: '9876' } }, { id: '555', name: 'Other', access_token: 'other-tok' }] });
    return new Response('?', { status: 500 });
  });
  assert.deepEqual(await threadsLongToken({ shortToken: 'th-short', appSecret: 'th-secret', fetch: f }), { token: 'th-long', days: 60 });
  assert.deepEqual(Object.fromEntries(new URL(calls[0].url).searchParams), { grant_type: 'th_exchange_token', client_secret: 'th-secret', access_token: 'th-short' });
  assert.deepEqual(await threadsUser('th-long', f), { id: '17841400', username: 'meitogi' });
  assert.deepEqual(Object.fromEntries(new URL(calls[1].url).searchParams), { fields: 'id,username', access_token: 'th-long' });
  assert.equal(await fbLongToken({ shortToken: 'fb-short', appId: 'app-1', appSecret: 'app-secret', fetch: f }), 'fb-long');
  assert.deepEqual(Object.fromEntries(new URL(calls[2].url).searchParams), { grant_type: 'fb_exchange_token', client_id: 'app-1', client_secret: 'app-secret', fb_exchange_token: 'fb-short' });
  assert.deepEqual(await fbPages('fb-long', f), [{ id: '1234', name: 'Meitogi', token: 'page-tok', igUserId: '9876' }, { id: '555', name: 'Other', token: 'other-tok', igUserId: null }]);
  assert.deepEqual(Object.fromEntries(new URL(calls[3].url).searchParams), { fields: 'id,name,access_token,instagram_business_account', access_token: 'fb-long' });
  for (const c of calls) assert.equal(c.method, 'GET');
  assert.deepEqual(FB_PERMISSIONS, ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement', 'instagram_basic', 'instagram_content_publish']);
});

test('upsertEnv replaces in place, appends the rest, keeps other lines ; saveEnv creates the file', async () => {
  assert.equal(upsertEnv('', { A: '1' }), 'A=1\n');
  assert.equal(upsertEnv('# comment\nA=old\nB=keep\n', { A: 'new', C: '3' }), '# comment\nA=new\nB=keep\nC=3\n');
  assert.equal(upsertEnv('A=1', { A: '2' }), 'A=2\n');
  const dir = await mkdtemp(join(tmpdir(), 'megaphone-env-'));
  try {
    await saveEnv(join(dir, '.env'), { LINKEDIN_TOKEN: 't', LINKEDIN_EXPIRES: '2026-12-22' });
    await chmod(join(dir, '.env'), 0o644);
    await saveEnv(join(dir, '.env'), { LINKEDIN_TOKEN: 't2' });
    assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'LINKEDIN_TOKEN=t2\nLINKEDIN_EXPIRES=2026-12-22\n');
    assert.equal((await stat(join(dir, '.env'))).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pagesUrl from ssh or https remotes', () => {
  assert.equal(pagesUrl('git@github.com:meitogi/megaphone.git'), 'https://meitogi.github.io/megaphone/');
  assert.equal(pagesUrl('https://github.com/Meitogi/megaphone'), 'https://meitogi.github.io/megaphone/');
  assert.equal(pagesUrl('https://github.com/meitogi/megaphone.git\n'), 'https://meitogi.github.io/megaphone/');
  assert.equal(pagesUrl('https://gitlab.com/x/y.git'), null);
  assert.equal(pagesUrl(null), null);
});

// The script with its stdin closed at once, as `< /dev/null` would.
function wizard(script) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, 'scripts', script)], { cwd: ROOT, env: { PATH: process.env.PATH } });
    let stdout = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.on('close', (code) => resolve({ code, stdout }));
    p.stdin.end();
  });
}

test('the wizards : with no terminal they explain step 1 and stop with exit 1, printing no secret', async () => {
  for (const script of ['linkedin-auth.mjs', 'meta-auth.mjs']) {
    const { code, stdout } = await wizard(script);
    assert.equal(code, 1, script);
    assert.match(stdout, /^1\. /m, script);
    assert.match(stdout, /no answer : stdin is closed, run this command in a terminal/, script);
  }
});
