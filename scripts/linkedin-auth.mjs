// `npm run linkedin:auth` : the LinkedIn consent, every 60 days, step by step.
// Needs a LinkedIn app (developer.linkedin.com) with the products « Share on
// LinkedIn » and « Sign In with LinkedIn using OpenID Connect ». Writes
// LINKEDIN_TOKEN, LINKEDIN_PERSON_URN and LINKEDIN_EXPIRES to .env and, when gh is
// logged in, to the repository's Actions secrets. The token is never printed.
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call } from '../lib/http.mjs';
import { dialogue, saveEnv, setSecret, ghRepo, gitRemote, pagesUrl } from './wizard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCOPES = 'openid profile w_member_social';
export const AUTHORIZE = 'https://www.linkedin.com/oauth/v2/authorization';
export const TOKEN = 'https://www.linkedin.com/oauth/v2/accessToken';
export const USERINFO = 'https://api.linkedin.com/v2/userinfo';

export function consentUrl({ clientId, redirectUri, state }) {
  return `${AUTHORIZE}?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, scope: SCOPES })}`;
}

// The address bar after consent → the code, once the state matches.
export function parseCallback(url, state) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    throw new Error('not an address : paste the whole address bar');
  }
  const p = u.searchParams;
  const error = p.get('error');
  if (error) throw new Error(`LinkedIn refused : ${error}${p.get('error_description') ? ` — ${p.get('error_description')}` : ''}`);
  if (p.get('state') !== state) throw new Error('state mismatch : this address does not come from the URL printed above');
  const code = p.get('code');
  if (!code) throw new Error('no code in this address');
  return code;
}

// The code → a 60-day token and its expiry day (YYYY-MM-DD).
export async function exchange({ code, clientId, clientSecret, redirectUri, fetch: f = fetch, now = Date.now() }) {
  const res = await call(f, 'linkedin token', TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }),
  });
  const { access_token, expires_in } = await res.json();
  if (!access_token) throw new Error('linkedin token : no access_token in the answer');
  return { token: access_token, expires: new Date(now + Number(expires_in) * 1000).toISOString().slice(0, 10) };
}

// OpenID Connect : the member id behind the token, as the Posts API `author`.
export async function person(token, f = fetch) {
  const { sub } = await (await call(f, 'linkedin userinfo', USERINFO, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (!sub) throw new Error('linkedin userinfo : no sub in the answer');
  return `urn:li:person:${sub}`;
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
    d.say('LinkedIn consent — a 60-day token for Megaphone to post as you.', '');
    const save = {};
    let { LINKEDIN_CLIENT_ID: clientId, LINKEDIN_CLIENT_SECRET: clientSecret } = env;
    d.say('1. The app : https://www.linkedin.com/developers/apps → your app → Auth tab.');
    if (clientId && clientSecret) d.say('   Client ID and secret read from .env.');
    else {
      d.say('   Copy « Client ID » and « Primary Client Secret ». The Products tab must list',
        '   « Share on LinkedIn » and « Sign In with LinkedIn using OpenID Connect ».');
      clientId ||= await d.ask('   Client ID :');
      clientSecret ||= await d.ask('   Client secret :');
      if (!clientId || !clientSecret) throw new Error('the client id and the client secret are both needed');
      if (await d.yes('   Save them to .env for next time ?')) Object.assign(save, { LINKEDIN_CLIENT_ID: clientId, LINKEDIN_CLIENT_SECRET: clientSecret });
    }

    d.say('', '2. Redirect URL : one of the app\'s « Authorized redirect URLs » (Auth tab), character',
      '   for character, trailing slash included. Megaphone uses its GitHub Pages address ;',
      '   the page does not even need to exist yet, only the address bar matters.');
    const redirectUri = await d.ask('   Redirect URL :', env.LINKEDIN_REDIRECT_URI || pagesUrl(await gitRemote(ROOT)) || '');
    if (!redirectUri) throw new Error('a redirect URL is needed');

    const state = randomBytes(16).toString('hex');
    d.say('', '3. Open this address in your browser, approve, then copy the WHOLE address bar of',
      '   the page you land on (it carries ?code=…&state=…) :', '', `   ${consentUrl({ clientId, redirectUri, state })}`, '');
    const code = parseCallback(await d.ask('   Paste the address you landed on :'), state);

    d.say('', '4. Exchanging the code…');
    const { token, expires } = await exchange({ code, clientId, clientSecret, redirectUri });
    const urn = await person(token);
    d.say(`   Token received, valid until ${expires}, posting as ${urn}.`);

    const values = { LINKEDIN_TOKEN: token, LINKEDIN_PERSON_URN: urn, LINKEDIN_EXPIRES: expires };
    await saveEnv(ENV, { ...save, ...values });
    d.say('', '5. Written to .env.');
    const repo = await ghRepo(ROOT);
    if (repo && (await d.yes(`   Set LINKEDIN_TOKEN, LINKEDIN_PERSON_URN and LINKEDIN_EXPIRES as Actions secrets of ${repo} with gh ?`))) {
      for (const k in values) await setSecret(k, values[k], { repo });
      d.say('   Secrets set.');
    } else {
      d.say('   On GitHub : Settings → Secrets and variables → Actions → New repository secret :',
        '   LINKEDIN_TOKEN (copy it from .env, never from here), ', `   LINKEDIN_PERSON_URN = ${urn}, LINKEDIN_EXPIRES = ${expires}.`);
    }
    d.say('', `Done. Run this again before ${expires} — refresh-tokens.yml fails ten days earlier to remind you.`);
  } catch (e) {
    d.say('', e.message);
    process.exitCode = 1;
  } finally {
    d.close();
  }
}
