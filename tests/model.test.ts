import { describe, it, expect } from 'vitest';
import { chooseLevel, parseManifest, vaultPath, manifestPath } from '../src/model';
import { asset, folder, id, makeManifest } from './helpers';

const available = new Set([...asset.variants, asset.original].map(level => level.path));
describe('manifest boundary', () => {
  it('parses complete manifests and mirrors canvas paths', () => {
    expect(parseManifest(makeManifest(), folder, 'Boards/Board.canvas').ok).toBe(true);
    expect(manifestPath(folder, 'Boards/Board.canvas')).toBe(`${folder}/canvases/Boards/Board.canvas/lod.json`);
  });
  it.each(['../escape', '/absolute', 'x//y', 'x\\y', 'https://host/a'])('rejects unsafe path %s', path => {
    expect(() => vaultPath(path)).toThrow();
  });
  it('rejects a stale manifest location and unsupported versions', () => {
    expect(parseManifest(makeManifest(), folder, 'Other.canvas').ok).toBe(false);
    expect(parseManifest({ ...makeManifest(), version: 2 }, folder, 'Boards/Board.canvas').ok).toBe(false);
  });
  it.each(['a'.repeat(31), 'a'.repeat(33), 'a'.repeat(64), 'g'.repeat(32), 'A'.repeat(32)])('rejects malformed hash %s', invalid => {
    const manifest = makeManifest();
    manifest.assets[id]!.original.fingerprint = invalid;
    expect(parseManifest(manifest, folder, manifest.canvas)).toEqual({ ok: false, error: 'Invalid fingerprint or asset ID' });
    const invalidId = { ...makeManifest(), assets: { [invalid]: asset } };
    expect(parseManifest(invalidId, folder, manifest.canvas)).toEqual({ ok: false, error: 'Invalid fingerprint or asset ID' });
  });
  it('rejects duplicate/upscaled tiers, malformed dimensions and provenance paths', () => {
    for (const mutate of [
      (m: ReturnType<typeof makeManifest>) => { m.assets[id]!.variants[1]!.width = 256; },
      (m: ReturnType<typeof makeManifest>) => { m.assets[id]!.variants[0]!.height = 200; },
      (m: ReturnType<typeof makeManifest>) => { m.assets[id]!.original.path = `${folder}/assets/recursive.png`; },
      (m: ReturnType<typeof makeManifest>) => { m.assets[id]!.original.path = `Other/LOD/assets/${id}/256.webp`; },
      (m: ReturnType<typeof makeManifest>) => { m.assets[id]!.variants[0]!.path = '../escape'; },
    ]) {
      const manifest = makeManifest(); mutate(manifest);
      expect(parseManifest(manifest, folder, manifest.canvas).ok).toBe(false);
    }
  });
});
describe('zoom selection', () => {
  it('starts small without needing original naturalWidth', () => {
    expect(chooseLevel(asset, 100, 1, available)?.path).toBe(asset.variants[0]!.path);
  });
  it('accounts for high-density screens', () => {
    expect(chooseLevel(asset, 300, 1, available)?.path).toBe(asset.variants[1]!.path);
    expect(chooseLevel(asset, 300, 3, available)?.path).toBe(asset.variants[2]!.path);
  });
  it('uses the original above the largest tier', () => {
    expect(chooseLevel(asset, 1600, 1, available)?.path).toBe(asset.original.path);
  });
  it('keeps upgrades deferred throughout movement', () => {
    expect(chooseLevel(asset, 2000, 1, available, asset.variants[0], true)?.path).toBe(asset.variants[0]!.path);
  });
  it('uses twenty-percent downshift hysteresis', () => {
    expect(chooseLevel(asset, 200, 1, available, asset.variants[1])?.path).toBe(asset.variants[1]!.path);
    expect(chooseLevel(asset, 170, 1, available, asset.variants[1])?.path).toBe(asset.variants[0]!.path);
  });
  it('downshifts through an intermediate tier when the smallest tier is near its threshold', () => {
    expect(chooseLevel(asset, 200, 1, available, asset.original)?.path).toBe(asset.variants[1]!.path);
    expect(chooseLevel(asset, 200, 1, available, asset.original, true)?.path).toBe(asset.variants[1]!.path);
  });
  it('uses the best available level during partial sync', () => {
    expect(chooseLevel(asset, 1000, 1, new Set([asset.variants[0]!.path]))?.path).toBe(asset.variants[0]!.path);
    expect(chooseLevel(asset, 100, 1, new Set())).toBeUndefined();
  });
});
