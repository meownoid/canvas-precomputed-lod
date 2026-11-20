// @vitest-environment node
import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseManifest } from '../src/model';

it('reads the actual Python-generated manifest through the TypeScript boundary', () => {
  const vault = mkdtempSync(join(tmpdir(), 'lod-contract-'));
  try {
    const python = process.env.LOD_PYTHON || 'python3';
    execFileSync(python, ['-c', `
from pathlib import Path
from PIL import Image
import json, sys
p = Path(sys.argv[1])
Image.new('RGBA', (1500, 750), (1, 2, 3, 0)).save(p / 'image.png', compress_level=0)
with (p / 'attachment.pdf').open('wb') as attachment:
    attachment.truncate(32 * 1024 * 1024)
(p / 'Board.canvas').write_text(json.dumps({'nodes': [
    {'id': 'a', 'type': 'file', 'file': 'image.png', 'x': 0, 'y': 0, 'width': 800, 'height': 400},
    {'id': 'b', 'type': 'file', 'file': 'attachment.pdf'},
]}))
`, vault]);
    execFileSync(python, ['-m', 'obsidian_prepare_lods', vault], { cwd: vault });
    const input: unknown = JSON.parse(readFileSync(join(vault, 'attachments/lod/canvases/Board.canvas/lod.json'), 'utf8'));
    const parsed = parseManifest(input, 'attachments/lod', 'Board.canvas');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const [id, asset] = Object.entries(parsed.value.assets)[0]!;
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(asset.original.fingerprint).toMatch(/^[0-9a-f]{32}$/);
      expect(asset.settings.sizes).toEqual([500, 1000, 2000]);
      expect(asset.variants.map(v => v.target)).toEqual([500, 1000]);
    }
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
