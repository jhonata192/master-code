import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

await build({
  bundle: true,
  platform: 'node',
  format: 'cjs',
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: path.join(root, 'dist-bundle/master-code.cjs'),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  logOverride: {
    'empty-import-meta': 'silent',
  },
});

console.log(`bundle ok (version ${pkg.version})`);
