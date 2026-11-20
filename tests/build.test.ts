// @vitest-environment node
import { expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('builds and packages from source without existing distribution files or NOTICE', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'lod-build-'));
  const python = process.env.LOD_PYTHON || 'python3';
  const required = ['LICENSE', 'main.js', 'manifest.json', 'styles.css'];
  try {
    for (const name of ['src', 'scripts', 'manifest.json', 'styles.css', 'LICENSE']) {
      cpSync(name, join(checkout, name), { recursive: true });
    }
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ type: 'module' }));
    symlinkSync(resolve('node_modules'), join(checkout, 'node_modules'), 'junction');
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: checkout, stdio: 'pipe' });
    const distribution = join(checkout, 'dist', 'canvas-precomputed-lod');
    expect(readdirSync(distribution).sort()).toEqual(required);
    expect(existsSync(join(checkout, 'main.js'))).toBe(false);
    // Leftovers in a local distribution must not become package dependencies or contents.
    writeFileSync(join(distribution, 'obsolete.txt'), 'old build output');
    execFileSync(python, ['scripts/package.py'], { cwd: checkout });
    const archives = JSON.parse(execFileSync(python, ['-c', `
import json, sys, zipfile
from pathlib import Path
root = Path(sys.argv[1])
result = {}
for kind in ('plugin', 'source'):
    with zipfile.ZipFile(root / f'canvas-precomputed-lod-{kind}.zip') as archive:
        assert archive.testzip() is None
        result[kind] = sorted(archive.namelist())
print(json.dumps(result))
`, checkout], { encoding: 'utf8' })) as { plugin: string[]; source: string[] };
    expect(archives.plugin).toEqual(required.map(name => `canvas-precomputed-lod/${name}`).sort());
    expect(archives.source).toContain('canvas-precomputed-lod/src/main.ts');
    expect(archives.source.some(name => name.includes('/node_modules/') || name.endsWith('.zip'))).toBe(false);
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});
