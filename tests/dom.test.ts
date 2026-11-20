import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasBinding, type BindingHost } from '../src/canvas-dom';
import { FRAME_BUDGET_MS, MAX_CONCURRENT_LOADS, MAX_ITEMS_PER_FRAME } from '../src/constants';
import { asset, makeManifest, url } from './helpers';

const active: CanvasBinding[] = [];
function fixture(options: Partial<BindingHost> = {}) {
  document.body.innerHTML = `<div id="root"><div class="canvas-wrapper"><div class="canvas" style="transform:matrix(0.2,0,0,0.2,0,0)"><div class="canvas-node"><div class="canvas-node-content"><div class="image-embed"><img src="${url(asset.variants[0]!.path)}"></div></div></div></div></div></div>`;
  const root = document.querySelector<HTMLElement>('#root')!;
  const board = root.querySelector<HTMLElement>('.canvas')!;
  const content = root.querySelector<HTMLElement>('.canvas-node-content')!;
  Object.defineProperties(content, { clientWidth: { value: 400 }, clientHeight: { value: 200 } });
  const img = root.querySelector('img')!;
  const host: BindingHost = { getManifest: vi.fn(async () => makeManifest()), resource: path => ({ url: url(path), available: true }), loadImage: vi.fn(async () => {}), ...options };
  const binding = new CanvasBinding(root, host); active.push(binding);
  const zoom = (scale: number) => { board.style.transform = `matrix(${scale},0,0,${scale},0,0)`; };
  return { root, board, content, img, host, binding, zoom };
}
function manyCards(count: number, options: Partial<BindingHost> = {}, shared = false) {
  const manifest = makeManifest();
  const assets = [asset];
  for (let index = 1; index < count; index++) {
    const next = structuredClone(asset);
    const id = index.toString(16).padStart(32, '0');
    next.original.path = `attachments/photo-${index}.png`;
    for (const level of next.variants) level.path = `attachments/lod/assets/${id}/${level.target}.webp`;
    manifest.assets[id] = next; assets.push(next);
  }
  const view = fixture({ getManifest: async () => manifest, ...options });
  const card = view.img.closest('.canvas-node')!;
  const images = [view.img];
  for (let index = 1; index < count; index++) {
    const clone = card.cloneNode(true) as HTMLElement;
    const content = clone.querySelector('.canvas-node-content')!;
    Object.defineProperties(content, { clientWidth: { value: 400 }, clientHeight: { value: 200 } });
    const img = clone.querySelector('img')!;
    img.src = url((shared ? asset : assets[index]!).variants[0]!.path);
    images.push(img); view.board.append(clone);
  }
  return { ...view, images, assets };
}
async function frames(ms = 80) { await vi.advanceTimersByTimeAsync(ms); }
function pointer(target: EventTarget, type: string, id = 1) {
  const event = new Event(type, { bubbles: true }); Object.defineProperty(event, 'pointerId', { value: id }); target.dispatchEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => window.setTimeout(() => fn(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => {
  for (const binding of active.splice(0)) binding.stop();
  document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('rendered canvas binding', () => {
  it('never requests the original at initial low zoom, even before natural dimensions exist', async () => {
    const { img, host } = fixture();
    expect(img.naturalWidth).toBe(0);
    await frames();
    expect(host.loadImage).not.toHaveBeenCalled();
    expect(img.getAttribute('src')).toBe(url(asset.variants[0]!.path));
    expect(img.style.width).toBe('400px');
  });
  it('upgrades, downgrades and preserves geometry', async () => {
    const { img, zoom } = fixture(); await frames();
    zoom(0.6); await frames(); expect(img.src).toBe(url(asset.variants[1]!.path));
    zoom(2); await frames(); expect(img.src).toBe(url(asset.variants[2]!.path));
    zoom(5); await frames(); expect(img.src).toBe(url(asset.original.path));
    zoom(0.1); await frames(); expect(img.src).toBe(url(asset.variants[0]!.path));
    expect([img.style.width, img.style.height]).toEqual(['400px', '200px']);
  });
  it('keeps upgrades deferred for a long pinch and until after release', async () => {
    const { img, root, zoom, host, binding } = fixture(); await frames();
    pointer(root, 'pointerdown', 1); pointer(root, 'pointerdown', 2); zoom(5);
    await frames(1000); expect(binding.moving).toBe(true); expect(host.loadImage).not.toHaveBeenCalled();
    pointer(window, 'pointerup', 1); await frames(500); expect(host.loadImage).not.toHaveBeenCalled();
    pointer(window, 'pointercancel', 2); await frames(199); expect(host.loadImage).not.toHaveBeenCalled();
    await frames(80); expect(img.src).toBe(url(asset.original.path));
  });
  it('handles touch fallback cancellation and wheel settling', async () => {
    vi.stubGlobal('PointerEvent', undefined);
    const { root, zoom, host } = fixture(); await frames();
    const start = new Event('touchstart', { bubbles: true }); Object.defineProperty(start, 'touches', { value: [1, 2] }); root.dispatchEvent(start);
    zoom(5); await frames(500); expect(host.loadImage).not.toHaveBeenCalled();
    const end = new Event('touchcancel'); Object.defineProperty(end, 'touches', { value: [] }); window.dispatchEvent(end);
    await frames(280); expect(host.loadImage).toHaveBeenCalledWith(url(asset.original.path));
  });
  it('keeps a touch gesture active after Safari cancels its pointers', async () => {
    const { root, zoom, host } = fixture(); await frames();
    pointer(root, 'pointerdown');
    const start = new Event('touchstart', { bubbles: true }); Object.defineProperty(start, 'touches', { value: [1] }); root.dispatchEvent(start);
    pointer(window, 'pointercancel'); zoom(5); await frames(800);
    expect(host.loadImage).not.toHaveBeenCalled();
    const end = new Event('touchend'); Object.defineProperty(end, 'touches', { value: [] }); window.dispatchEvent(end);
    await frames(280); expect(host.loadImage).toHaveBeenCalledWith(url(asset.original.path));
  });
  it('does not apply a stale upgrade after zooming out or stopping', async () => {
    let finish!: () => void;
    const loadImage = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const { img, zoom, binding } = fixture({ loadImage }); await frames();
    zoom(5); await frames(); expect(loadImage).toHaveBeenCalledTimes(1);
    zoom(0.1); await frames(); finish(); await frames();
    expect(img.src).toBe(url(asset.variants[0]!.path));
    binding.stop(); zoom(5); await frames(); expect(img.src).toBe(url(asset.variants[0]!.path));
  });
  it('retains a working preview on failure and retries after a relevant file refresh', async () => {
    const loadImage = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('not synced'));
    const { img, zoom, binding } = fixture({ loadImage }); await frames();
    zoom(5); await frames(); expect(img.src).toBe(url(asset.variants[0]!.path));
    expect(loadImage).toHaveBeenCalled();
    loadImage.mockResolvedValue(); await binding.refresh(); await frames();
    expect(img.src).toBe(url(asset.original.path));
  });
  it('rebinds after the canvas subtree is replaced', async () => {
    const { root, board, zoom, binding } = fixture(); await frames();
    zoom(.6); await frames();
    const replacement = board.cloneNode(true) as HTMLElement;
    const nextContent = replacement.querySelector<HTMLElement>('.canvas-node-content')!;
    Object.defineProperties(nextContent, { clientWidth: { value: 400 }, clientHeight: { value: 200 } });
    board.replaceWith(replacement);
    replacement.style.transform = 'matrix(5,0,0,5,0,0)'; await frames();
    expect(root.querySelector('img')!.src).toBe(url(asset.original.path));
    binding.stop(); expect(root.querySelector('img')!.src).toBe(url(asset.variants[0]!.path));
  });
  it('does not upgrade hidden views', async () => {
    const { root, zoom, host } = fixture(); root.style.visibility = 'hidden';
    zoom(5); await frames(); expect(host.loadImage).not.toHaveBeenCalled();
  });
  it('discovers a late manifest and keeps missing metadata inert', async () => {
    const getManifest = vi.fn<BindingHost['getManifest']>().mockResolvedValue(null);
    const { img, binding, host, zoom } = fixture({ getManifest }); zoom(5); await frames();
    expect(host.loadImage).not.toHaveBeenCalled();
    getManifest.mockResolvedValue(makeManifest()); await binding.refresh(); await frames();
    expect(img.src).toBe(url(asset.original.path));
  });
  it('keeps unsynced originals from being requested', async () => {
    const { img, zoom, host } = fixture({ resource: path => ({ url: url(path), available: path !== asset.original.path }) });
    await frames(); zoom(5); await frames();
    expect(img.src).toBe(url(asset.variants[2]!.path));
    expect(host.loadImage).not.toHaveBeenCalledWith(url(asset.original.path));
  });
  it.each([0.2, 5])('falls back to an available image when the saved preview is missing at scale %s', async scale => {
    let synced = false;
    const smallest = asset.variants[0]!.path;
    const { img, zoom, host, binding } = fixture({
      resource: path => ({ url: url(path), available: synced || path !== smallest }),
    });
    zoom(scale); await frames();
    const fallback = scale === 5 ? asset.original.path : asset.variants[1]!.path;
    expect(img.src).toBe(url(fallback));
    expect(host.loadImage).not.toHaveBeenCalledWith(url(smallest));
    expect(binding.references(smallest)).toBe(true);
    expect(binding.references('attachments/lod/assets')).toBe(true);
    synced = true;
    await binding.refresh(); zoom(0.1); await frames();
    expect(img.src).toBe(url(smallest));
  });
  it('keeps the saved source when no image tier has synced', async () => {
    const { img, zoom, host } = fixture({ resource: path => ({ url: url(path), available: false }) });
    zoom(5); await frames();
    expect(img.src).toBe(url(asset.variants[0]!.path));
    expect(host.loadImage).not.toHaveBeenCalled();
  });
  it('leaves native original cards unmanaged', async () => {
    const { img, host } = fixture();
    img.src = url(asset.original.path); await frames();
    expect(host.loadImage).not.toHaveBeenCalled();
    expect(img.style.width).toBe('');
  });
  it.each(['stop', 'missing manifest', 'next frame'])('preserves a newer native source and responsive attributes on %s', async action => {
    const getManifest = vi.fn<BindingHost['getManifest']>().mockResolvedValue(makeManifest());
    const { img, zoom, binding } = fixture({ getManifest });
    img.setAttribute('srcset', 'old-native.png 1x'); img.setAttribute('sizes', '80vw');
    await frames(); zoom(5); await frames();
    img.src = url('attachments/new.png');
    img.setAttribute('srcset', 'new-native.png 1x'); img.setAttribute('sizes', '50vw');
    if (action === 'stop') binding.stop();
    else if (action === 'missing manifest') { getManifest.mockResolvedValue(null); await binding.refresh(); }
    await frames();
    expect(img.src).toBe(url('attachments/new.png'));
    expect(img.getAttribute('srcset')).toBe('new-native.png 1x');
    expect(img.getAttribute('sizes')).toBe('50vw');
  });
  it('preserves a newer resource version on the same path during unload', async () => {
    const { img, zoom, binding } = fixture();
    await frames(); zoom(5); await frames();
    const updated = `${img.src}?mtime=123`;
    img.src = updated;
    binding.stop();
    expect(img.src).toBe(updated);
  });
  it('restores source, responsive attributes and styles on unload', async () => {
    const { img, zoom, binding } = fixture();
    // These attributes belong to the native element before the first discovery frame.
    img.setAttribute('srcset', 'native.png 1x'); img.setAttribute('sizes', '80vw'); img.style.width = '75%';
    await frames(); zoom(5); await frames(); expect(img.hasAttribute('srcset')).toBe(false);
    binding.stop();
    expect(img.src).toBe(url(asset.variants[0]!.path));
    expect(img.getAttribute('srcset')).toBe('native.png 1x'); expect(img.style.width).toBe('75%');
    expect(img.getAttribute('sizes')).toBe('80vw');
  });
  it('follows a wrapped zoom transform', async () => {
    const { root, board, img } = fixture();
    board.style.transform = 'none'; root.querySelector<HTMLElement>('.canvas-wrapper')!.style.transform = 'matrix(5,0,0,5,0,0)';
    await frames(); expect(img.src).toBe(url(asset.original.path));
  });
  it('yields to other UI work before finishing a large canvas and eventually visits every card', async () => {
    const { images } = manyCards(160);
    let styledDuringInput = 0;
    window.setTimeout(() => { styledDuringInput = images.filter(img => img.style.width).length; }, 17);
    await frames(17);
    expect(styledDuringInput).toBeGreaterThan(0);
    expect(styledDuringInput).toBeLessThan(images.length);
    await frames(500);
    expect(images.every(img => img.style.width === '400px')).toBe(true);
  });
  it('yields early when geometry reads consume the frame budget', async () => {
    let elapsed = 0;
    vi.spyOn(window.performance, 'now').mockImplementation(() => elapsed);
    const { images } = manyCards(MAX_ITEMS_PER_FRAME);
    for (const img of images) {
      vi.spyOn(img.closest('.canvas-node')!, 'getBoundingClientRect').mockImplementation(() => {
        elapsed += FRAME_BUDGET_MS / 2 + 1;
        return new DOMRect(0, 0, 400, 200);
      });
    }
    await frames(16);
    const processed = images.filter(img => img.style.width).length;
    expect(processed).toBeGreaterThan(0);
    expect(processed).toBeLessThan(images.length);
    await frames(1000);
    expect(images.every(img => img.style.width === '400px')).toBe(true);
  });
  it('keeps visiting later cards during continuous input', async () => {
    const { images, root } = manyCards(160);
    pointer(root, 'pointerdown');
    for (let frame = 0; frame < 12; frame++) { pointer(root, 'pointermove'); await frames(16); }
    expect(images.every(img => img.style.width === '400px')).toBe(true);
  });
  it('bounds concurrent loads and applies a completed image without waiting for other loads', async () => {
    const finishes: Array<() => void> = [];
    let inFlight = 0, peak = 0;
    const loadImage = vi.fn(() => new Promise<void>(resolve => {
      inFlight++; peak = Math.max(peak, inFlight);
      finishes.push(() => { inFlight--; resolve(); });
    }));
    const { images, assets, zoom } = manyCards(12, { loadImage }); zoom(5);
    await frames();
    expect(loadImage).toHaveBeenCalledTimes(MAX_CONCURRENT_LOADS);
    finishes[0]!(); await frames();
    expect(images[0]!.src).toBe(url(assets[0]!.original.path));
    expect(images[1]!.src).toBe(url(assets[1]!.variants[0]!.path));
    expect(loadImage).toHaveBeenCalledTimes(MAX_CONCURRENT_LOADS + 1);
    for (let index = 1; index < images.length; index++) { finishes[index]!(); await frames(); }
    expect(peak).toBe(MAX_CONCURRENT_LOADS);
    expect(images.every((img, index) => img.src === url(assets[index]!.original.path))).toBe(true);
  });
  it('shares an in-flight image load across repeated cards', async () => {
    let finish!: () => void;
    const loadImage = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const { images, zoom } = manyCards(80, { loadImage }, true); zoom(5);
    await frames(500); expect(loadImage).toHaveBeenCalledTimes(1);
    finish(); await frames(500);
    expect(images.every(img => img.src === url(asset.original.path))).toBe(true);
  });
  it('keeps the load limit across refreshes and ignores obsolete completions', async () => {
    const finishes: Array<(success: boolean) => void> = [];
    const loadImage = vi.fn(() => new Promise<void>((resolve, reject) => {
      finishes.push(success => { if (success) resolve(); else reject(new Error('old load failed')); });
    }));
    const { images, assets, binding, zoom } = manyCards(12, { loadImage }); zoom(5);
    await frames(); expect(loadImage).toHaveBeenCalledTimes(MAX_CONCURRENT_LOADS);
    await binding.refresh(); await frames(); expect(loadImage).toHaveBeenCalledTimes(MAX_CONCURRENT_LOADS);
    for (const finish of finishes.slice()) finish(false);
    await frames(); expect(loadImage).toHaveBeenCalledTimes(MAX_CONCURRENT_LOADS * 2);
    expect(loadImage.mock.calls.slice(MAX_CONCURRENT_LOADS)).toEqual(loadImage.mock.calls.slice(0, MAX_CONCURRENT_LOADS));
    binding.stop();
    for (const finish of finishes.slice(MAX_CONCURRENT_LOADS)) finish(true);
    await frames(); expect(loadImage).toHaveBeenCalledTimes(MAX_CONCURRENT_LOADS * 2);
    expect(images.every((img, index) => img.src === url(assets[index]!.variants[0]!.path))).toBe(true);
  });
  it('rechecks zoom and visibility before starting loads skipped at the concurrency limit', async () => {
    const finishes: Array<() => void> = [];
    const loadImage = vi.fn(() => new Promise<void>(resolve => finishes.push(resolve)));
    const { root, images, assets, zoom } = manyCards(12, { loadImage }); zoom(5);
    await frames(); expect(loadImage).toHaveBeenCalledTimes(MAX_CONCURRENT_LOADS);
    root.style.visibility = 'hidden';
    for (const finish of finishes) finish();
    await frames(); expect(loadImage).toHaveBeenCalledTimes(MAX_CONCURRENT_LOADS);
    expect(images.every((img, index) => img.src === url(assets[index]!.variants[0]!.path))).toBe(true);
    zoom(.1); root.style.visibility = 'visible'; await frames();
    expect(loadImage).toHaveBeenCalledTimes(MAX_CONCURRENT_LOADS);
    expect(images.every((img, index) => img.src === url(assets[index]!.variants[0]!.path))).toBe(true);
  });
  it('cancels unfinished chunks on unload', async () => {
    const { images, binding, host, zoom } = manyCards(160);
    await frames(16);
    expect(images.some(img => img.style.width)).toBe(true);
    expect(images.some(img => !img.style.width)).toBe(true);
    binding.stop(); zoom(5); await frames(1000);
    expect(images.every(img => !img.style.width)).toBe(true);
    expect(host.loadImage).not.toHaveBeenCalled();
  });
  it('abandons a partially scanned subtree when Obsidian replaces the board', async () => {
    const { board, binding, root } = manyCards(160, {}, true);
    await frames(16);
    const replacement = board.cloneNode(true) as HTMLElement;
    for (const content of replacement.querySelectorAll('.canvas-node-content')) {
      Object.defineProperties(content, { clientWidth: { value: 400 }, clientHeight: { value: 200 } });
    }
    for (const img of replacement.querySelectorAll('img')) img.removeAttribute('style');
    replacement.style.transform = 'matrix(5,0,0,5,0,0)'; board.replaceWith(replacement);
    await frames(1000);
    const images = [...root.querySelectorAll('img')];
    expect(images.every(img => img.src.endsWith('.png'))).toBe(true);
    binding.stop();
    expect(images.every(img => img.src.endsWith('/256.webp') && !img.style.width)).toBe(true);
  });
});
