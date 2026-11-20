import { CanvasBinding, loadBrowserImage } from '../src/canvas-dom';
import { ManifestCache } from '../src/manifest-cache';

const cache = new ManifestCache({ readText: async path => {
  const response = await fetch('/' + path);
  return response.ok ? response.text() : null;
} }, 'attachments/lod');
const catalog = await cache.get('Board.canvas');
if (!catalog) throw new Error('No fixture metadata');
const asset = Object.values(catalog.assets)[0]!;
const root = document.querySelector<HTMLElement>('#root')!;
root.innerHTML = `<div class="canvas-wrapper"><div class="canvas" style="transform:scale(.2)"><div class="canvas-node"><div class="canvas-node-content"><div class="image-embed"><img alt="Generated resolution test image" src="/${asset.variants[0]!.path}"></div></div></div></div></div>`;
const bindings: CanvasBinding[] = [];
function bind(element: HTMLElement): void {
  bindings.push(new CanvasBinding(element, {
    getManifest: () => cache.get('Board.canvas'),
    resource: path => ({ url: '/' + path, available: true }),
    loadImage: url => loadBrowserImage(url),
  }));
}
bind(root);
function zoom(scale: number): void {
  for (const board of document.querySelectorAll<HTMLElement>('.canvas')) board.style.transform = `scale(${scale})`;
  document.querySelector('#scale')!.textContent = `${Math.round(scale * 100)}%`;
}
document.querySelector('#small')!.addEventListener('click', () => zoom(.2));
document.querySelector('#large')!.addEventListener('click', () => zoom(5));
const api = {
  zoom,
  original: '/' + asset.original.path,
  smallest: '/' + asset.variants[0]!.path,
  async metadata() { await Promise.all([cache.get('Board.canvas'), cache.get('Board.canvas')]); },
  secondView() {
    const second = root.cloneNode(true) as HTMLElement;
    second.id = 'second'; second.style.position = 'absolute'; second.style.visibility = 'hidden';
    document.body.append(second); bind(second);
  },
  replaceBoard() { const board = root.querySelector('.canvas')!; board.replaceWith(board.cloneNode(true)); },
  populate(count: number) {
    zoom(.01);
    const board = root.querySelector('.canvas')!, card = board.querySelector<HTMLElement>('.canvas-node')!;
    const cards = document.createDocumentFragment();
    for (let index = 0; index < count; index++) {
      const clone = card.cloneNode(true) as HTMLElement;
      clone.style.position = 'absolute'; clone.style.left = `${index % 16 * 620}px`; clone.style.top = `${Math.floor(index / 16) * 320}px`;
      const img = clone.querySelector('img')!; img.src = `/${asset.variants[0]!.path}`; img.removeAttribute('style');
      cards.append(clone);
    }
    board.replaceChildren(cards);
  },
  unload() { for (const binding of bindings) binding.stop(); },
};
(window as unknown as { lodTest: typeof api }).lodTest = api;
document.body.dataset.ready = 'true';
