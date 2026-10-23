// `node scripts/refresh.mjs` — what refresh-tokens.yml runs weekly. Threads : the
// 60-day token is refreshed and written back to the THREADS_TOKEN secret with gh
// (GH_TOKEN = a PAT with Secrets write on this repository). LinkedIn : a self-serve
// app gets no programmatic refresh ; within ten days of LINKEDIN_EXPIRES the run
// fails, and GitHub's email says to run `npm run linkedin:auth`.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call } from '../lib/http.mjs';
import { THREADS_HOST } from '../lib/meta.mjs';
import { setSecret } from './wizard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WARN_DAYS = 10;

// Returns the number of failures. `mask` receives the new token before it is
// stored : the Action prints it as `::add-mask::` so no later line can leak it.
export async function refresh({ env, fetch: f = fetch, now = Date.now(), log = console.log, mask = () => {} }) {
  let failed = 0;
  const old = env.THREADS_TOKEN;
  if (!old) log('threads : not configured, skipped');
  else {
    try {
      const url = `${THREADS_HOST}/refresh_access_token?${new URLSearchParams({ grant_type: 'th_refresh_token', access_token: old })}`;
      const { access_token, expires_in } = await (await call(f, 'threads refresh', url)).json();
      if (!access_token) throw new Error('threads refresh : no access_token in the answer');
      mask(access_token);
      await setSecret('THREADS_TOKEN', access_token, { repo: env.GITHUB_REPOSITORY || null, env });
      log(`threads : token refreshed, valid ${Math.round(Number(expires_in) / 86400)} days`);
    } catch (e) {
      log(`threads : ${e.message.split(old).join('***')}`);
      failed++;
    }
  }
  const expires = env.LINKEDIN_EXPIRES;
  if (!env.LINKEDIN_TOKEN) log('linkedin : not configured, skipped');
  else if (!expires || Number.isNaN(Date.parse(expires))) {
    log('linkedin : LINKEDIN_EXPIRES is not set, expiry unknown : run npm run linkedin:auth');
    failed++;
  } else {
    const days = Math.floor((Date.parse(expires) - now) / 86400e3);
    if (days <= WARN_DAYS) {
      log(`linkedin : token expires ${expires} (${days} days) : run npm run linkedin:auth`);
      failed++;
    } else log(`linkedin : token expires ${expires}, ${days} days left`);
  }
  return failed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  // The runner swallows the ::add-mask:: line itself ; elsewhere nothing is printed.
  const mask = process.env.GITHUB_ACTIONS === 'true' ? (t) => console.log(`::add-mask::${t}`) : () => {};
  const failed = await refresh({ env: process.env, mask });
  process.exit(failed ? 1 : 0);
}
