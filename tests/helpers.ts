import type { Asset, Manifest } from '../src/model';

export const id = 'a'.repeat(32);
export const folder = 'attachments/lod';
export const asset: Asset = {
  original: { path: 'attachments/photo.png', width: 2400, height: 1200, fingerprint: 'b'.repeat(32) },
  settings: { sizes: [256, 768, 1600], quality: 85, format: 'webp', algorithm: 1 },
  variants: [256, 768, 1600].map(target => ({ path: `${folder}/assets/${id}/${target}.webp`, width: target, height: target / 2, target })),
};
export function makeManifest(): Manifest {
  return structuredClone({ version: 1, generator: 'canvas-precomputed-lod', canvas: 'Boards/Board.canvas', assets: { [id]: asset } });
}
export function url(path: string): string { return `https://vault.test/${path}`; }
