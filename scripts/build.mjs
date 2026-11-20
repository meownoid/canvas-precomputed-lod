import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist/canvas-precomputed-lod', { recursive: true });
const result = await build({
  entryPoints: ['src/main.ts'], outfile: 'dist/canvas-precomputed-lod/main.js', bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2022', external: ['obsidian'],
  metafile: true, logLevel: 'info',
});
const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports);
if (imports.some(item => item.path !== 'obsidian')) throw new Error('Unexpected runtime dependency');
for (const file of ['manifest.json', 'styles.css', 'LICENSE']) {
  await copyFile(file, `dist/canvas-precomputed-lod/${file}`);
}
