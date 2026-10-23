// `npm run due` : what the hourly Action runs. Publishes every `ready` post of
// posts/ whose `date` has passed, through `run()` of publish.mjs, then moves each
// complete one to published/ with `status: published`. Complete = every network
// of the post that this environment is configured for holds a success or a skip.
// An incomplete post stays `ready` in posts/ : the next run retries its failed
// networks and skips the others, which already hold a success.
import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, serialize, notDue, pending } from '../lib/post.mjs';
import { run, able, NAME } from './publish.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// `dir` holds posts/ and published/. Returns the number of failed networks.
export async function due({ dir = ROOT, now = Date.now(), env, fetch: f = fetch, sleep, log = console.log }) {
  const posts = join(dir, 'posts');
  const configured = able(env);
  let failed = 0;
  for (const name of (await readdir(posts)).filter((n) => NAME.test(n)).sort()) {
    const file = join(posts, name);
    const why = notDue(parse(await readFile(file, 'utf8')), now);
    if (why) {
      // Drafts are the normal case ; a `ready` post that is not due says why.
      if (!why.startsWith('status')) log(`${name} : not due, ${why}`);
      continue;
    }
    log(`${name} : due`);
    failed += await run({ file, env, fetch: f, sleep, log: (line) => log(`  ${line}`) });
    // run() wrote the results : read them back.
    const post = parse(await readFile(file, 'utf8'));
    const left = pending(post, configured);
    if (left.length) {
      log(`${name} : stays ready, retried next run (${left.join(', ')})`);
      continue;
    }
    post.meta.status = 'published';
    await writeFile(file, serialize(post));
    await rename(file, join(dir, 'published', name));
    log(`${name} : published, moved to published/`);
  }
  return failed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const failed = await due({ env: process.env });
  process.exit(failed ? 1 : 0);
}
