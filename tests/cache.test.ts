import { describe, it, expect, vi } from 'vitest';
import { ManifestCache } from '../src/manifest-cache';
import { folder, makeManifest } from './helpers';

describe('one metadata read per canvas', () => {
  it('shares concurrent reads and reuses the resolved result', async () => {
    const readText = vi.fn(async () => JSON.stringify(makeManifest()));
    const cache = new ManifestCache({ readText }, folder);
    const [a, b] = await Promise.all([cache.get('Boards/Board.canvas'), cache.get('Boards/Board.canvas')]);
    expect(a).toBe(b); await cache.get('Boards/Board.canvas');
    expect(readText).toHaveBeenCalledTimes(1);
    cache.invalidate('Boards/Board.canvas'); await cache.get('Boards/Board.canvas');
    expect(readText).toHaveBeenCalledTimes(2);
  });
  it('caches missing metadata until a file event invalidates it', async () => {
    const readText = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
    const cache = new ManifestCache({ readText }, folder);
    expect(await cache.get('Boards/Board.canvas')).toBeNull();
    readText.mockResolvedValue(JSON.stringify(makeManifest()));
    expect(await cache.get('Boards/Board.canvas')).toBeNull();
    cache.invalidate('Boards/Board.canvas');
    expect(await cache.get('Boards/Board.canvas')).not.toBeNull();
    expect(readText).toHaveBeenCalledTimes(2);
  });
  it('fails closed on corrupt metadata and retries after invalidation', async () => {
    const readText = vi.fn(async () => '{broken');
    const report = vi.fn();
    const cache = new ManifestCache({ readText }, folder, report);
    expect(await cache.get('Boards/Board.canvas')).toBeNull();
    expect(report).toHaveBeenCalledTimes(1);
  });
});
