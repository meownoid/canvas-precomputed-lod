import { manifestPath, parseManifest, type Manifest } from './model';

export interface ManifestReader { readText(path: string): Promise<string | null> }

/** Promise caching shares the first read across concurrent views, including misses. */
export class ManifestCache {
  private entries = new Map<string, Promise<Manifest | null>>();
  constructor(private reader: ManifestReader, public folder: string, private report: (message: string) => void = console.warn) {}

  get(canvas: string): Promise<Manifest | null> {
    let entry = this.entries.get(canvas);
    if (!entry) {
      entry = this.read(canvas);
      this.entries.set(canvas, entry);
    }
    return entry;
  }
  private async read(canvas: string): Promise<Manifest | null> {
    try {
      const text = await this.reader.readText(manifestPath(this.folder, canvas));
      if (text === null) return null;
      const parsed = parseManifest(JSON.parse(text) as unknown, this.folder, canvas);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    } catch (error) {
      this.report(`[canvas-precomputed-lod] ${canvas}: ${String(error)}`);
      return null;
    }
  }
  invalidate(canvas: string): void { this.entries.delete(canvas); }
  clear(folder = this.folder): void { this.folder = folder; this.entries.clear(); }
}
