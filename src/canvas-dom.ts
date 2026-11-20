import { chooseLevel, type Asset, type Level, type Manifest } from './model';
import { FRAME_BUDGET_MS, GESTURE_SETTLE_MS, IMAGE_LOAD_TIMEOUT_MS, MAX_CONCURRENT_LOADS, MAX_ITEMS_PER_FRAME } from './constants';

export interface BindingHost {
  getManifest(): Promise<Manifest | null>;
  resource(path: string): { url: string; available: boolean };
  loadImage(url: string): Promise<void>;
}
interface Attributes { src: string | null; srcset: string | null; sizes: string | null }
interface ImageState {
  img: HTMLImageElement;
  asset: Asset;
  current: Level;
  saved: Attributes;
  styles: Record<string, string>;
  applied: string;
}
interface Scan {
  board: HTMLElement;
  states: MapIterator<[HTMLImageElement, ImageState]>;
  images: ArrayIterator<HTMLImageElement>;
  cleaning: boolean;
}
interface Replacement { state: ImageState; target: Level; width: number; height: number }
const STYLE_KEYS = ['width', 'height', 'max-width', 'max-height', 'object-fit'];

export function resourceKey(input: string, base: string): string {
  try { const url = new URL(input, base); url.search = ''; url.hash = ''; return url.href; }
  catch { return input; }
}

/** Canvas has no stable public rendering API. Keep all DOM assumptions here. */
export class CanvasDomAdapter {
  constructor(public root: HTMLElement) {}
  board(): HTMLElement | null { return this.root.querySelector('.canvas-wrapper .canvas, .canvas'); }
  wrapper(board: HTMLElement): HTMLElement { return board.closest<HTMLElement>('.canvas-wrapper') ?? board; }
  images(board: HTMLElement): NodeListOf<HTMLImageElement> {
    return board.querySelectorAll<HTMLImageElement>('.canvas-node img');
  }
  managed(img: HTMLImageElement): boolean {
    return img.matches('.canvas-node img') && !img.closest('.markdown-embed, .markdown-preview-view, .markdown-source-view, .markdown-rendered');
  }
  scale(board: HTMLElement): number {
    const win = this.root.ownerDocument.defaultView!;
    const wrapper = this.wrapper(board);
    const stop = wrapper.parentElement;
    let scale = 1;
    for (let el: HTMLElement | null = board, depth = 0; el && el !== stop && depth < 8; el = el.parentElement, depth++) {
      const transform = win.getComputedStyle(el).transform;
      if (!transform || transform === 'none') continue;
      try {
        const Matrix = win.DOMMatrixReadOnly;
        if (Matrix) { const m = new Matrix(transform); scale *= Math.hypot(m.a, m.b) || 1; }
        else {
          const match = /^matrix\(([^)]+)\)$/.exec(transform);
          if (match) { const n = match[1]!.split(',').map(Number); scale *= Math.hypot(n[0]!, n[1]!) || 1; }
        }
      } catch { /* Invalid third-party transforms do not disable a board. */ }
    }
    return scale;
  }
  box(img: HTMLImageElement, asset: Asset, scale: number): { width: number; height: number; screenEdge: number } | null {
    const content = img.closest<HTMLElement>('.canvas-node-content') ?? img.parentElement;
    if (!content) return null;
    const rect = content.getBoundingClientRect();
    const style = content.ownerDocument.defaultView!.getComputedStyle(content);
    const horizontal = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const vertical = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const width = (content.clientWidth || rect.width / scale) - horizontal;
    const height = (content.clientHeight || rect.height / scale) - vertical;
    if (width <= 0 || height <= 0) return null;
    const ratio = Math.min(width / asset.original.width, height / asset.original.height);
    const fitWidth = asset.original.width * ratio, fitHeight = asset.original.height * ratio;
    return { width: fitWidth, height: fitHeight, screenEdge: Math.max(fitWidth, fitHeight) * scale };
  }
  visible(img: HTMLImageElement): boolean {
    const win = this.root.ownerDocument.defaultView!;
    for (const element of [this.root, img]) {
      const style = win.getComputedStyle(element);
      if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return false;
    }
    const rect = img.closest('.canvas-node')?.getBoundingClientRect();
    const root = this.root.getBoundingClientRect();
    if (!rect || (!root.width && !root.height)) return true;
    return rect.right >= root.left && rect.left <= root.right && rect.bottom >= root.top && rect.top <= root.bottom;
  }
}

export class CanvasBinding {
  private adapter: CanvasDomAdapter;
  private states = new Map<HTMLImageElement, ImageState>();
  private manifest: Manifest | null = null;
  private resourceIndex = new Map<string, { asset: Asset; level: Level }>();
  private resources = new Map<string, string>();
  private available = new Set<string>();
  private files = new Set<string>();
  private ready = new Set<string>();
  private loading = new Set<string>();
  private scan: Scan | undefined;
  private dirty = false;
  private pointers = new Set<number>();
  private touchCount = 0;
  private settling = false;
  private idleTimer: number | undefined;
  private raf = 0;
  private stopped = false;
  private revision = 0;
  private cleanups: Array<() => void> = [];
  private observer: MutationObserver;
  private resize: ResizeObserver | undefined;
  private observed = new WeakSet<Element>();
  private win: Window & typeof globalThis;

  constructor(public root: HTMLElement, private host: BindingHost) {
    this.adapter = new CanvasDomAdapter(root);
    this.win = root.ownerDocument.defaultView!;
    this.observer = new this.win.MutationObserver(records => {
      if (records.some(record => record.type === 'childList' ||
          (record.target instanceof this.win.HTMLImageElement ? record.attributeName === 'src' &&
            this.states.get(record.target)?.applied !== record.target.getAttribute('src') : true))) this.schedule();
    });
    this.observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'src'] });
    if (this.win.ResizeObserver) this.resize = new this.win.ResizeObserver(() => this.schedule());
    this.listen(this.win, 'resize', () => this.schedule());
    this.listen(root, 'wheel', () => this.move());
    // Safari may cancel pointers while touch gestures continue. Track touch lifetime independently.
    this.listen(root, 'touchstart', event => { this.touchCount = (event as TouchEvent).touches.length; this.move(); });
    this.listen(root, 'touchmove', () => { if (this.touchCount) this.move(); });
    for (const type of ['touchend', 'touchcancel']) this.listen(this.win, type, event => {
      if (this.touchCount) { this.touchCount = (event as TouchEvent).touches.length; this.move(); }
    });
    if (this.win.PointerEvent) {
      this.listen(root, 'pointerdown', event => { this.pointers.add((event as PointerEvent).pointerId); this.move(); });
      this.listen(root, 'pointermove', () => { if (this.pointers.size) this.move(); });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        this.listen(this.win, type, event => {
          if (this.pointers.delete((event as PointerEvent).pointerId)) this.move();
        });
      }
    } else {
      this.listen(root, 'mousedown', () => { this.pointers.add(-1); this.move(); });
      this.listen(this.win, 'mousemove', () => { if (this.pointers.size) this.move(); });
      this.listen(this.win, 'mouseup', () => { if (this.pointers.delete(-1)) this.move(); });
    }
    this.listen(this.win, 'blur', () => { this.pointers.clear(); this.touchCount = 0; this.move(); });
    void this.refresh();
  }

  private listen(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler, { passive: true, capture: true });
    this.cleanups.push(() => target.removeEventListener(type, handler, { capture: true }));
  }
  get moving(): boolean { return this.pointers.size > 0 || this.touchCount > 0 || this.settling; }
  private move(): void {
    this.settling = true;
    if (this.idleTimer !== undefined) this.win.clearTimeout(this.idleTimer);
    this.idleTimer = this.win.setTimeout(() => { this.settling = false; this.schedule(); }, GESTURE_SETTLE_MS);
    this.schedule();
  }
  async refresh(): Promise<void> {
    if (this.stopped) return;
    const revision = ++this.revision;
    const manifest = await this.host.getManifest();
    if (this.stopped || revision !== this.revision) return;
    this.manifest = manifest;
    this.ready.clear();
    this.scan = undefined;
    this.rebuildResources();
    if (!manifest) {
      for (const state of this.states.values()) this.restore(state);
      this.states.clear();
    }
    this.schedule();
  }
  private rebuildResources(): void {
    this.resources.clear(); this.resourceIndex.clear(); this.available.clear(); this.files.clear();
    if (!this.manifest) return;
    for (const asset of Object.values(this.manifest.assets)) {
      for (const level of [...asset.variants, asset.original]) {
        this.files.add(level.path);
        for (let slash = level.path.lastIndexOf('/'); slash > 0; slash = level.path.lastIndexOf('/', slash - 1)) {
          this.files.add(level.path.slice(0, slash));
        }
        const { url, available } = this.host.resource(level.path);
        if (available) {
          this.resources.set(level.path, url);
          this.available.add(level.path);
        }
        // A missing saved variant still identifies a managed card during partial sync.
        // Ordinary original cards remain untouched.
        if (level !== asset.original) this.resourceIndex.set(resourceKey(url, this.root.ownerDocument.baseURI), { asset, level });
      }
    }
  }
  references(path: string): boolean { return this.files.has(path); }
  schedule(): void {
    this.dirty = true;
    this.requestFrame();
  }
  private requestFrame(): void {
    if (this.stopped || this.raf) return;
    this.raf = this.win.requestAnimationFrame(() => { this.raf = 0; this.sync(); });
  }
  private restore(state: ImageState, source = true): void {
    if (this.ownsSource(state)) {
      if (source) this.attribute(state.img, 'src', state.saved.src);
      this.attribute(state.img, 'srcset', state.saved.srcset);
      this.attribute(state.img, 'sizes', state.saved.sizes);
    }
    for (const key of STYLE_KEYS) {
      const value = state.styles[key]!;
      if (value) state.img.style.setProperty(key, value);
      else state.img.style.removeProperty(key);
    }
  }
  private attribute(img: HTMLImageElement, name: string, value: string | null): void {
    if (value === null) img.removeAttribute(name); else img.setAttribute(name, value);
  }
  private sync(): void {
    if (!this.manifest || this.stopped) return;
    const board = this.adapter.board();
    if (!board) { this.scan = undefined; return; }
    if (!this.scan || this.scan.board !== board) {
      this.scan = { board, states: this.states.entries(), images: this.adapter.images(board).values(), cleaning: true };
      this.dirty = false;
    }
    const scan = this.scan;
    const scale = this.adapter.scale(board);
    const plan: Replacement[] = [];
    const deadline = this.win.performance.now() + FRAME_BUDGET_MS;
    for (let count = 0; count < MAX_ITEMS_PER_FRAME && this.win.performance.now() < deadline; count++) {
      if (scan.cleaning) {
        const next = scan.states.next();
        if (!next.done) {
          const [img, state] = next.value;
          if (!board.contains(img) || !this.adapter.managed(img) || !this.ownsSource(state)) {
            this.restore(state, false); this.states.delete(img);
          }
          continue;
        }
        scan.cleaning = false;
      }
      const next = scan.images.next();
      if (next.done) { this.scan = undefined; break; }
      const replacement = this.plan(next.value, board, scale);
      if (replacement) plan.push(replacement);
    }
    // Read geometry before writing within each chunk, then yield to the UI.
    for (const { state, target, width, height } of plan) {
      const img = state.img;
      const declarations: Record<string, string> = { width: `${width}px`, height: `${height}px`, 'max-width': '100%', 'max-height': '100%', 'object-fit': 'contain' };
      for (const [key, value] of Object.entries(declarations)) if (img.style.getPropertyValue(key) !== value) img.style.setProperty(key, value);
      if (target.path === state.current.path) continue;
      const url = this.resources.get(target.path);
      if (!url) continue;
      if (this.ready.has(url)) {
        img.removeAttribute('srcset'); img.removeAttribute('sizes');
        state.current = target; state.applied = url; img.src = url;
      } else this.load(target, url);
    }
    // Finish an in-progress pass even during continuous movement; revisit earlier
    // cards afterward if geometry or load readiness changed while it was running.
    if (this.scan || this.dirty) this.requestFrame();
  }
  private ownsSource(state: ImageState): boolean {
    if (state.img.getAttribute('src') === state.applied) return true;
    try { return state.img.src === new URL(state.applied, this.root.ownerDocument.baseURI).href; }
    catch { return false; }
  }
  private plan(img: HTMLImageElement, board: HTMLElement, scale: number): Replacement | undefined {
    // The DOM and viewport can change between chunks.
    if (!board.contains(img) || !this.adapter.managed(img)) return;
    let state = this.states.get(img);
    if (state && !this.ownsSource(state)) {
      this.restore(state, false); this.states.delete(img); state = undefined;
    }
    if (!state) {
      const match = this.resourceIndex.get(resourceKey(img.src, this.root.ownerDocument.baseURI));
      if (!match) return;
      const styles: Record<string, string> = {};
      for (const key of STYLE_KEYS) styles[key] = img.style.getPropertyValue(key);
      const smallest = this.resources.get(match.asset.variants[0]!.path);
      const nativeSource = img.getAttribute('src');
      const savedSource = smallest && resourceKey(smallest, this.root.ownerDocument.baseURI) !== resourceKey(img.src, this.root.ownerDocument.baseURI)
        ? smallest : nativeSource;
      state = { img, asset: match.asset, current: match.level, styles,
        saved: { src: savedSource, srcset: img.getAttribute('srcset'), sizes: img.getAttribute('sizes') },
        applied: img.getAttribute('src') ?? img.src };
      this.states.set(img, state);
      const content = img.closest('.canvas-node-content');
      if (content && !this.observed.has(content)) { this.observed.add(content); this.resize?.observe(content); }
    }
    if (!this.adapter.visible(img)) return;
    const box = this.adapter.box(img, state.asset, scale);
    if (!box) return;
    const target = chooseLevel(state.asset, box.screenEdge, this.win.devicePixelRatio, this.available, state.current, this.moving);
    if (target) return { state, target, width: box.width, height: box.height };
  }
  private load(target: Level, url: string): void {
    if (this.loading.has(url) || this.loading.size >= MAX_CONCURRENT_LOADS) return;
    this.loading.add(url);
    const revision = this.revision;
    const finish = (success: boolean): void => {
      this.loading.delete(url);
      if (this.stopped) return;
      if (revision === this.revision) {
        if (success) this.ready.add(url);
        else this.available.delete(target.path);
      }
      // Cards skipped at the concurrency limit are re-evaluated at their current
      // size/visibility rather than loading a queued, potentially stale target.
      this.schedule();
    };
    void this.host.loadImage(url).then(() => finish(true), () => finish(false));
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true; this.revision++; this.scan = undefined;
    this.observer.disconnect(); this.resize?.disconnect();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    if (this.raf) this.win.cancelAnimationFrame(this.raf);
    if (this.idleTimer !== undefined) this.win.clearTimeout(this.idleTimer);
    for (const state of this.states.values()) this.restore(state);
    this.states.clear(); this.ready.clear(); this.resources.clear(); this.resourceIndex.clear(); this.available.clear(); this.files.clear();
  }
}

export function loadBrowserImage(url: string, win: Window & typeof globalThis = window): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new win.Image();
    const finish = (error?: Error): void => {
      win.clearTimeout(timer); img.onload = null; img.onerror = null;
      if (error) { img.removeAttribute('src'); reject(error); } else resolve();
    };
    const timer = win.setTimeout(() => finish(new Error('Image load timed out')), IMAGE_LOAD_TIMEOUT_MS);
    img.onload = () => finish();
    img.onerror = () => finish(new Error('Image load failed'));
    img.src = url;
  });
}
