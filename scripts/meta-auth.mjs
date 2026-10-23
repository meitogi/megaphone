// `npm run meta:auth` : the Meta token exchanges, step by step. One Meta app
// (developers.facebook.com) carries Threads, the Facebook page and the Instagram
// professional account. Writes THREADS_USER_ID, THREADS_TOKEN, FB_PAGE_ID,
// FB_PAGE_TOKEN and IG_USER_ID to .env and, when gh is logged in, to the
// repository's Actions secrets. Tokens are never printed.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call } from '../lib/http.mjs';
import { GRAPH, THREADS, THREADS_HOST } from '../lib/meta.mjs';
import { dialogue, saveEnv, setSecret, ghRepo } from './wizard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// What the Graph API Explorer token must carry for the page and Instagram.
export const FB_PERMISSIONS = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement', 'instagram_basic', 'instagram_content_publish'];

// A short-lived Threads token (User Token Generator) → the 60-day one.
export async function threadsLongToken({ shortToken, appSecret, fetch: f = fetch }) {
  const url = `${THREADS_HOST}/access_token?${new URLSearchParams({ grant_type: 'th_exchange_token', client_secret: appSecret, access_token: shortToken })}`;
  const { access_token, expires_in } = await (await call(f, 'threads exchange', url)).json();
  if (!access_token) throw new Error('threads exchange : no access_token in the answer');
  return { token: access_token, days: Math.round(Number(expires_in) / 86400) };
}

export async function threadsUser(token, f = fetch) {
  const { id, username } = await (await call(f, 'threads profile', `${THREADS}/me?${new URLSearchParams({ fields: 'id,username', access_token: token })}`)).json();
  if (!id) throw new Error('threads profile : no id in the answer');
  return { id, username };
}

// A short-lived user token (Graph API Explorer) → the 60-day user token.
export async function fbLongToken({ shortToken, appId, appSecret, fetch: f = fetch }) {
  const url = `${GRAPH}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: shortToken })}`;
  const { access_token } = await (await call(f, 'facebook exchange', url)).json();
  if (!access_token) throw new Error('facebook exchange : no access_token in the answer');
  return access_token;
}

// The pages the user manages, each with its own token (which does not expire when
// the user token is long-lived) and the Instagram account linked to it, if any.
export async function fbPages(userToken, f = fetch) {
  const { data } = await (await call(f, 'facebook pages', `${GRAPH}/me/accounts?${new URLSearchParams({ fields: 'id,name,access_token,instagram_business_account', access_token: userToken })}`)).json();
  return (data || []).map((p) => ({ id: p.id, name: p.name, token: p.access_token, igUserId: p.instagram_business_account ? p.instagram_business_account.id : null }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ENV = join(ROOT, '.env');
  try {
    process.loadEnvFile(ENV);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const env = process.env;
  const d = dialogue();
  try {
    d.say('Meta tokens — Threads, the Facebook page, Instagram, from one Meta app.', '',
      'The app : https://developers.facebook.com/apps → your app. It stays in Development',
      'mode ; your own account, added as a tester (App roles), is the only one it posts for.', '');
    const values = {};
    const save = {};

    if (await d.yes('1. Threads — set it up now ?')) {
      d.say('   Use cases → Threads API → Settings : copy « Threads App secret », then under',
        '   « User Token Generator » generate a token for your Threads account (it must have',
        '   accepted the tester invite : Threads app → Settings → Account → Website permissions).');
      let appSecret = env.THREADS_APP_SECRET;
      if (!appSecret) {
        appSecret = await d.ask('   Threads App secret :');
        if (appSecret && (await d.yes('   Save it to .env for next time ?'))) save.THREADS_APP_SECRET = appSecret;
      }
      const shortToken = await d.ask('   Generated token :');
      if (!appSecret || !shortToken) throw new Error('the Threads app secret and a generated token are both needed');
      const { token, days } = await threadsLongToken({ shortToken, appSecret });
      const { id, username } = await threadsUser(token);
      d.say(`   Long-lived token received, valid ${days} days, for @${username} (id ${id}).`);
      Object.assign(values, { THREADS_USER_ID: id, THREADS_TOKEN: token });
    }

    d.say('');
    if (await d.yes('2. Facebook page and Instagram — set them up now ?')) {
      let { META_APP_ID: appId, META_APP_SECRET: appSecret } = env;
      if (!appId || !appSecret) {
        d.say('   App settings → Basic : copy « App ID » and « App secret ».');
        appId ||= await d.ask('   App ID :');
        appSecret ||= await d.ask('   App secret :');
        if (!appId || !appSecret) throw new Error('the app id and the app secret are both needed');
        if (await d.yes('   Save them to .env for next time ?')) Object.assign(save, { META_APP_ID: appId, META_APP_SECRET: appSecret });
      }
      d.say('   Tools → Graph API Explorer : pick the app, « User Token », add the permissions',
        `   ${FB_PERMISSIONS.join(', ')},`,
        '   Generate Access Token (approve, tick your page and Instagram account), copy it.');
      const shortToken = await d.ask('   Generated token :');
      if (!shortToken) throw new Error('a generated user token is needed');
      const userToken = await fbLongToken({ shortToken, appId, appSecret });
      const pages = await fbPages(userToken);
      if (!pages.length) throw new Error('this account manages no Facebook page : create the page first');
      let page = pages[0];
      if (pages.length > 1) {
        d.say('   Pages :', ...pages.map((p, i) => `   ${i + 1}. ${p.name} (${p.id})${p.igUserId ? ', Instagram linked' : ''}`));
        page = pages[Number(await d.ask('   Which one ?', '1')) - 1];
        if (!page) throw new Error('no such page');
      }
      d.say(`   Page « ${page.name} » (${page.id}) : token received (it does not expire).`);
      Object.assign(values, { FB_PAGE_ID: page.id, FB_PAGE_TOKEN: page.token });
      if (page.igUserId) {
        d.say(`   Instagram professional account linked : id ${page.igUserId}.`);
        values.IG_USER_ID = page.igUserId;
      } else {
        d.say('   No Instagram account linked to this page : Instagram stays off. Link a',
          '   professional account to the page (Instagram → Settings → Business tools), run again.');
      }
    }

    const names = Object.keys(values);
    if (!names.length) throw new Error('nothing set up');
    await saveEnv(ENV, { ...save, ...values });
    d.say('', '3. Written to .env.');
    const repo = await ghRepo(ROOT);
    if (repo && (await d.yes(`   Set ${names.join(', ')} as Actions secrets of ${repo} with gh ?`))) {
      for (const k of names) await setSecret(k, values[k], { repo });
      d.say('   Secrets set.');
    } else {
      d.say('   On GitHub : Settings → Secrets and variables → Actions → New repository secret,',
        `   one per value of .env : ${names.join(', ')} (copy the tokens from .env, never from here).`);
    }
    d.say('', 'Done. refresh-tokens.yml renews the Threads token weekly ; the page token does not expire.');
  } catch (e) {
    d.say('', e.message);
    process.exitCode = 1;
  } finally {
    d.close();
  }
}
