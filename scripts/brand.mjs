// `npm run brand` : the profile images from the two SVG sources in assets/.
//   assets/avatar-400.png, assets/avatar-1024.png   ← meitogi-avatar.svg
//   assets/banner-1500x500.png                      ← meitogi-icon.svg + wordmark
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
// resvg-wasm sees no system font : the text needs font buffers.
const FONTS = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'];

const CREAM = '#F2EAE0';
const INK = '#161A20';
const MUTED = '#6B5F55';

function png(svg, width, fontBuffers = []) {
  const opts = { fitTo: { mode: 'width', value: width }, font: { fontBuffers, defaultFontFamily: 'DejaVu Sans' } };
  return new Resvg(svg, opts).render().asPng();
}

function banner(icon) {
  // The icon is nested as an inner <svg> ; its own cream background blends in.
  // Content sits right of centre : X and Bluesky overlay the avatar bottom-left.
  const inner = icon.replace(/<svg[^>]*>/, '<svg x="380" y="90" width="320" height="320" viewBox="0 0 512 512">');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
  <rect width="1500" height="500" fill="${CREAM}"/>
  ${inner}
  <text x="730" y="255" font-family="DejaVu Sans" font-weight="bold" font-size="112" fill="${INK}">meitogi</text>
  <text x="736" y="320" font-family="DejaVu Sans" font-size="30" fill="${MUTED}">open-source tooling for AI coding agents</text>
</svg>`;
}

const require = createRequire(import.meta.url);
await initWasm(await readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));

let fonts;
try {
  fonts = await Promise.all(FONTS.map((f) => readFile(f)));
} catch {
  console.error(`brand : DejaVu Sans not found (${FONTS[0]}) ; install fonts-dejavu-core`);
  process.exit(1);
}

const avatar = await readFile(join(ASSETS, 'meitogi-avatar.svg'), 'utf8');
const icon = await readFile(join(ASSETS, 'meitogi-icon.svg'), 'utf8');
const out = {
  'avatar-400.png': png(avatar, 400),
  'avatar-1024.png': png(avatar, 1024),
  'banner-1500x500.png': png(banner(icon), 1500, fonts),
};
for (const name in out) {
  await writeFile(join(ASSETS, name), out[name]);
  console.log(`assets/${name}`);
}
