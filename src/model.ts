import { DOWNSHIFT_RATIO, RESOLUTION_HEADROOM } from './constants';

export const GENERATOR = 'canvas-precomputed-lod';
export const DEFAULT_LOD_DIR = 'attachments/lod';
export interface Level { path: string; width: number; height: number }
export interface Variant extends Level { target: number }
export interface GenerationSettings { sizes: [number, number, number]; quality: number; format: 'webp'; algorithm: 1 }
export interface Asset {
  original: Level & { fingerprint: string };
  settings: GenerationSettings;
  variants: Variant[];
}
export interface Manifest {
  version: 1;
  generator: typeof GENERATOR;
  canvas: string;
  assets: Record<string, Asset>;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function vaultPath(input: unknown): string {
  if (typeof input !== 'string' || !input || /[\\\0:]/.test(input) || input.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Expected a vault-relative POSIX path');
  }
  return input;
}
export function lodFolder(input: unknown): string {
  const path = vaultPath(input);
  if (path.split('/').some(part => part.startsWith('.'))) throw new Error('LOD folder must be visible to Obsidian and sync');
  return path;
}
export function manifestPath(folder: string, canvas: string): string {
  return `${lodFolder(folder)}/canvases/${vaultPath(canvas)}/lod.json`;
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Expected a positive integer');
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) throw new Error('Invalid fingerprint or asset ID');
  return value;
}

export function parseManifest(input: unknown, folder: string, canvas: string): Result<Manifest> {
  try {
    lodFolder(folder);
    const raw = object(input);
    if (raw.version !== 1 || raw.generator !== GENERATOR || vaultPath(raw.canvas) !== canvas || !canvas.endsWith('.canvas')) {
      throw new Error('Unsupported manifest or mismatched canvas path');
    }
    const assets: Record<string, Asset> = Object.create(null) as Record<string, Asset>;
    for (const [id, entry] of Object.entries(object(raw.assets))) {
      hash(id);
      const data = object(entry), source = object(data.original), config = object(data.settings);
      const original = { path: vaultPath(source.path), width: integer(source.width), height: integer(source.height), fingerprint: hash(source.fingerprint) };
      if (original.path === folder || original.path.startsWith(folder + '/') || /(?:^|\/)assets\/[0-9a-f]{32}\/[0-9]+\.webp$/.test(original.path)) {
        throw new Error('Original cannot be a generated asset');
      }
      if (!Array.isArray(config.sizes) || config.sizes.length !== 3) throw new Error('Expected three target sizes');
      const sizes = config.sizes.map(integer) as [number, number, number];
      if (sizes.some((n, i) => n > 16383 || (i > 0 && n <= sizes[i - 1]!))) throw new Error('Invalid target sizes');
      const quality = integer(config.quality);
      if (quality > 100 || config.format !== 'webp' || config.algorithm !== 1) throw new Error('Unsupported generation settings');
      if (!Array.isArray(data.variants) || data.variants.length < 1 || data.variants.length > 3) throw new Error('Expected one to three variants');
      const edge = Math.max(original.width, original.height);
      let previous = 0;
      const variants = data.variants.map(item => {
        const value = object(item);
        const variant: Variant = { path: vaultPath(value.path), width: integer(value.width), height: integer(value.height), target: integer(value.target) };
        const pixels = Math.max(variant.width, variant.height);
        if (!sizes.includes(variant.target) || pixels !== variant.target || pixels <= previous || pixels >= edge ||
            variant.path !== `${folder}/assets/${id}/${variant.target}.webp` ||
            variant.width !== Math.max(1, Math.floor(original.width * variant.target / edge + 0.5)) ||
            variant.height !== Math.max(1, Math.floor(original.height * variant.target / edge + 0.5))) {
          throw new Error('Invalid downscale dimensions, order or path');
        }
        previous = pixels;
        return variant;
      });
      assets[id] = { original, settings: { sizes, quality, format: 'webp', algorithm: 1 }, variants };
    }
    return { ok: true, value: { version: 1, generator: GENERATOR, canvas, assets } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function pixels(level: Level): number { return Math.max(level.width, level.height); }

/** No I/O: availability includes only synced files and excludes failed loads. */
export function chooseLevel(asset: Asset, screenEdge: number, dpr: number, available: ReadonlySet<string>, current?: Level, moving = false): Level | undefined {
  const levels: Level[] = [...asset.variants, asset.original].filter(level => available.has(level.path));
  if (!levels.length || !Number.isFinite(screenEdge) || screenEdge <= 0) return current;
  const need = screenEdge * (Number.isFinite(dpr) && dpr > 0 ? dpr : 1) * RESOLUTION_HEADROOM;
  let desired = levels.find(level => pixels(level) >= need) ?? levels.at(-1)!;
  if (current && available.has(current.path)) {
    if (pixels(desired) > pixels(current) && moving) desired = current;
    if (pixels(desired) < pixels(current)) {
      // A smaller tier near its threshold must not block a safe intermediate downshift.
      desired = levels.find(level => pixels(level) < pixels(current) && need <= pixels(level) * DOWNSHIFT_RATIO) ?? current;
    }
  }
  return desired;
}
