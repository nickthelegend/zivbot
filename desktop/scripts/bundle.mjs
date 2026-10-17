// Bundle the ZivBot server into one ESM file for the desktop app, and copy the
// web build + demo repo next to it. Electron runs it with ELECTRON_RUN_AS_NODE.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const out = join(here, '../build/app');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execSync('npm run build', { cwd: repo, stdio: 'inherit' });
await build({
  entryPoints: [join(repo, 'server/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(out, 'server.mjs'),
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
await build({ entryPoints: [join(repo, 'server/mcp.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: join(out, 'mcp.mjs'), banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" } });
cpSync(join(repo, 'dist'), join(out, 'dist'), { recursive: true });
cpSync(join(repo, 'demo'), join(out, 'demo'), { recursive: true });
writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }));
console.log('bundled →', out);
