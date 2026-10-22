// `npm run publish -- posts/<file>.md [--network bluesky|mastodon|discord] [--force]`
// Publishes one post now to its direct networks, writes each result into the
// file's frontmatter, prints one line per network. Credentials from `.env`.
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, serialize, expandNetworks, posted, record } from '../lib/post.mjs';
import { DIRECT, publish, loadImage } from '../lib/publish.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The session that builds each of the other networks.
const LATER = { devto: 3, x: 3, threads: 4, linkedin: 4, facebook: 4, instagram: 4 };

export function creds(env) {
  return {
    bskyHandle: env.BLUESKY_HANDLE,
    bskyPassword: env.BLUESKY_APP_PASSWORD,
    mastoUrl: env.MASTODON_URL,
    mastoToken: env.MASTODON_TOKEN,
    discordWebhook: env.DISCORD_WEBHOOK,
  };
}

// Returns the number of attempted networks that failed.
export async function run({ file, networks, force = false, env, fetch: f = fetch, sleep, log = console.log }) {
  const post = parse(await readFile(file, 'utf8'));
  const name = file.split('/').pop();
  const c = creds(env);
  const secrets = Object.values(c);
  let image;
  let failed = 0;
  for (const n of networks || expandNetworks(post.meta.networks)) {
    if (!DIRECT.includes(n)) {
      log(`${n} : not built yet, session ${LATER[n] || '?'}`);
      continue;
    }
    const done = posted(post, n);
    if (done && !force) {
      log(`${n} : already published ${done} (--force to post again)`);
      continue;
    }
    try {
      image ??= loadImage(post, async (p) => new Uint8Array(await readFile(join(dirname(file), p))));
      const result = await publish(post, n, { creds: c, image: await image, name, fetch: f, sleep });
      record(post, n, result);
    } catch (e) {
      record(post, n, { error: e.message }, secrets);
      failed++;
    }
    // Written after each network, so a crash never forgets a post that went out.
    await writeFile(file, serialize(post));
    log(`${n} : ${post.meta[n]}`);
  }
  return failed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const networks = [];
  let file;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') force = true;
    else if (args[i] === '--network') networks.push(args[++i]);
    else file = args[i];
  }
  if (!file) {
    console.error('usage : npm run publish -- posts/<file>.md [--network bluesky|mastodon|discord] [--force]');
    process.exit(2);
  }
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const failed = await run({ file, networks: networks.length ? networks : null, force, env: process.env });
  process.exit(failed ? 1 : 0);
}
