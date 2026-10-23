// Shared by the auth wizards and refresh.mjs : the terminal dialogue, `.env`
// writes, `gh secret set` with the value on stdin, the repository behind `origin`.
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// `KEY=value` lines : a key already there is replaced in place, a new one appended.
export function upsertEnv(text, values) {
  const lines = text ? text.replace(/\n$/, '').split('\n') : [];
  const seen = {};
  const out = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (!m || !(m[1] in values)) return line;
    seen[m[1]] = true;
    return `${m[1]}=${values[m[1]]}`;
  });
  for (const k in values) if (!seen[k]) out.push(`${k}=${values[k]}`);
  return `${out.join('\n')}\n`;
}

export async function saveEnv(file, values) {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await writeFile(file, upsertEnv(text, values), { mode: 0o600 });
  // `mode` only applies to a new file : an existing .env is tightened too.
  await chmod(file, 0o600);
}

// `gh secret set <name>` with the value on stdin — never an argument (process
// list, shell history), never printed. `repo` is `owner/repo`, or null for the
// repository of the current directory. `env` carries GH_TOKEN in the Action.
export function setSecret(name, value, { repo = null, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['secret', 'set', name];
    if (repo) args.push('-R', repo);
    const p = spawn('gh', args, { env, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`gh secret set ${name} : exit ${code} ${err.trim()}`.trim()))));
    p.stdin.end(value);
  });
}

// `owner/repo` of this checkout when gh is logged in and `origin` is on GitHub ;
// null otherwise, and the wizard prints the manual steps instead.
export async function ghRepo(cwd, env = process.env) {
  try {
    await exec('gh', ['auth', 'status'], { cwd, env });
    const { stdout } = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd, env });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function gitRemote(cwd) {
  try {
    return (await exec('git', ['remote', 'get-url', 'origin'], { cwd })).stdout.trim() || null;
  } catch {
    return null;
  }
}

// The GitHub Pages address of a GitHub remote (ssh or https), or null.
export function pagesUrl(remote) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(remote || '').trim());
  return m ? `https://${m[1].toLowerCase()}.github.io/${m[2]}/` : null;
}

// The terminal dialogue. `ask` returns the trimmed answer, or `fallback` when the
// user just presses Enter ; a closed stdin (no terminal) ends with one clear line.
export function dialogue({ input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output });
  // A question on a closed stdin never settles : the close event answers instead.
  const closed = new Promise((resolve) => rl.once('close', () => resolve(null)));
  return {
    async ask(question, fallback = '') {
      const a = await Promise.race([rl.question(fallback ? `${question} [${fallback}] ` : `${question} `), closed]);
      if (a === null) throw new Error('no answer : stdin is closed, run this command in a terminal');
      return a.trim() || fallback;
    },
    async yes(question) {
      return /^y(es)?$/i.test(await this.ask(`${question} (y/N)`));
    },
    say(...lines) {
      output.write(`${lines.join('\n')}\n`);
    },
    close() {
      rl.close();
    },
  };
}
