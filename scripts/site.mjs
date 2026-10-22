// `node scripts/site.mjs [out]` : builds the GitHub Pages site into site/ by
// allowlist — index.html and the flat lib/*.mjs, nothing else — and refuses the
// build when the sources hold anything else (a symlink, a sub-directory, `.env`,
// a stray file) or when the output does not match the list. posts/ never ships.
import { lstat, readdir, mkdir, copyFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = /^[\w-][\w.-]*\.mjs$/;

async function regular(path, rel) {
  const s = await lstat(path);
  if (s.isSymbolicLink()) throw new Error(`site : refused, ${rel} is a symlink`);
  if (!s.isFile()) throw new Error(`site : refused, ${rel} is not a file`);
}

// The files that ship, relative to `root`.
export async function allowlist(root) {
  await regular(join(root, 'index.html'), 'index.html');
  const files = ['index.html'];
  for (const name of (await readdir(join(root, 'lib'))).sort()) {
    if (!MODULE.test(name)) throw new Error(`site : refused, lib/${name} is not a module`);
    await regular(join(root, 'lib', name), `lib/${name}`);
    files.push(`lib/${name}`);
  }
  return files;
}

// Every entry of `dir`, relative, symlinks refused.
async function walk(dir, rel = '') {
  const out = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new Error(`site : refused, ${path} is a symlink`);
    if (e.isDirectory()) out.push(...(await walk(dir, path)));
    else out.push(path);
  }
  return out;
}

// The second lock : `out` holds exactly `files`.
export async function guard(out, files) {
  const got = (await walk(out)).sort();
  for (const f of got) if (!files.includes(f)) throw new Error(`site : refused, ${f} is not on the allowlist`);
  if (got.length !== files.length) throw new Error(`site : ${files.length} files expected, ${got.length} built`);
}

export async function site({ root = ROOT, out = join(root, 'site') } = {}) {
  const files = await allowlist(root);
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'lib'), { recursive: true });
  for (const f of files) await copyFile(join(root, f), join(out, f));
  await guard(out, files);
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const files = await site(process.argv[2] ? { out: process.argv[2] } : {});
    console.log(`site/ : ${files.join(', ')}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
