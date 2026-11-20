import { afterEach, describe, expect, it, vi } from 'vitest';
import CanvasPrecomputedLod from '../src/main';
import { CanvasBinding } from '../src/canvas-dom';
import { FILE_REFRESH_DELAY_MS } from '../src/constants';
import { TFile, type Plugin as StubPlugin } from './obsidian-stub';
import { asset, folder, makeManifest, url } from './helpers';

function emitter() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    on(name: string, fn: (...args: any[]) => void) {
      const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set);
      return { off() { set.delete(fn); } };
    },
    fire(name: string, ...args: any[]) { for (const fn of listeners.get(name) ?? []) fn(...args); },
  };
}
const plugins: CanvasPrecomputedLod[] = [];
afterEach(() => {
  for (const plugin of plugins.splice(0)) { plugin.onunload(); (plugin as unknown as StubPlugin).dispose(); }
  document.body.innerHTML = ''; vi.restoreAllMocks();
});
async function flush() { await new Promise(resolve => window.setTimeout(resolve, FILE_REFRESH_DELAY_MS + 30)); }
describe('plugin lifecycle integration', () => {
  it('shares reads across leaves, reacts to sync events and leaves no work after unload', async () => {
    let text: string | null = JSON.stringify(makeManifest());
    const vaultEvents = emitter(), workspaceEvents = emitter();
    const metadata = new TFile(`${folder}/canvases/Boards/Board.canvas/lod.json`);
    const files = new Map([metadata, ...[...asset.variants, asset.original].map(level => new TFile(level.path))].map(file => [file.path, file]));
    function root() {
      const el = document.createElement('div');
      el.innerHTML = `<div class="canvas"><div class="canvas-node"><div class="canvas-node-content"><img src="${url(asset.variants[0]!.path)}"></div></div></div>`;
      document.body.append(el); return el;
    }
    const leaves = [1, 2].map(() => ({ view: { file: new TFile('Boards/Board.canvas'), contentEl: root() } }));
    let layoutReady!: () => void;
    const cachedRead = vi.fn(async () => text!);
    const refresh = vi.spyOn(CanvasBinding.prototype, 'refresh');
    const app = {
      vault: { ...vaultEvents, cachedRead, adapter: { getResourcePath: url }, getAbstractFileByPath: (path: string) => files.get(path) ?? null, getResourcePath: (file: TFile) => url(file.path) },
      workspace: { ...workspaceEvents, getLeavesOfType: () => leaves, onLayoutReady: (fn: () => void) => { layoutReady = fn; fn(); } },
    };
    const plugin = new CanvasPrecomputedLod(app as never, {} as never); plugins.push(plugin);
    await plugin.onload(); await flush();
    expect(cachedRead).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    vaultEvents.fire('create', new TFile('attachments/unrelated.png')); await flush();
    expect(cachedRead).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 10; index++) {
      vaultEvents.fire('modify', metadata);
      vaultEvents.fire('modify', new TFile(asset.original.path));
    }
    await flush(); expect(cachedRead).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(4);
    files.delete(metadata.path); text = null; vaultEvents.fire('delete', metadata); await flush();
    files.set(metadata.path, metadata); text = JSON.stringify(makeManifest()); vaultEvents.fire('create', metadata); await flush();
    expect(cachedRead).toHaveBeenCalledTimes(3);
    const original = leaves[0]!.view.contentEl.querySelector('img')!.src;
    const refreshes = refresh.mock.calls.length;
    vaultEvents.fire('modify', metadata);
    plugin.onunload(); (plugin as unknown as StubPlugin).dispose();
    layoutReady(); workspaceEvents.fire('layout-change'); await flush();
    expect(cachedRead).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(refreshes);
    expect(leaves[0]!.view.contentEl.querySelector('img')!.src).toBe(original);
  });
  it('refreshes only affected boards and handles manifest folder events', async () => {
    const first = makeManifest(), second = makeManifest();
    second.canvas = 'Boards/Other.canvas';
    Object.values(second.assets)[0]!.original.path = 'attachments/other.png';
    const catalogs = new Map([first, second].map(manifest => [`${folder}/canvases/${manifest.canvas}/lod.json`, JSON.stringify(manifest)]));
    const vaultEvents = emitter();
    const lookup = vi.fn((path: string) => new TFile(path));
    const cachedRead = vi.fn(async (file: TFile) => catalogs.get(file.path)!);
    const leaves = [first, second].map(manifest => {
      const root = document.createElement('div');
      root.innerHTML = `<div class="canvas"><div class="canvas-node"><div class="canvas-node-content"><img src="${url(asset.variants[0]!.path)}"></div></div></div>`;
      document.body.append(root);
      return { view: { file: new TFile(manifest.canvas), contentEl: root } };
    });
    const app = {
      vault: { ...vaultEvents, cachedRead, adapter: { getResourcePath: url }, getAbstractFileByPath: lookup, getResourcePath: (file: TFile) => url(file.path) },
      workspace: { ...emitter(), getLeavesOfType: () => leaves, onLayoutReady: (fn: () => void) => fn() },
    };
    const plugin = new CanvasPrecomputedLod(app as never, {} as never); plugins.push(plugin);
    await plugin.onload(); await flush();
    lookup.mockClear();
    vaultEvents.fire('modify', new TFile(asset.original.path)); await flush();
    expect(lookup).toHaveBeenCalledWith(asset.original.path);
    expect(lookup).not.toHaveBeenCalledWith('attachments/other.png');
    expect(cachedRead).toHaveBeenCalledTimes(2);

    vaultEvents.fire('rename', { path: `${folder}/canvases/Boards/Moved.canvas` }, `${folder}/canvases/${first.canvas}`);
    await flush();
    expect(cachedRead).toHaveBeenCalledTimes(3);
    expect(cachedRead).toHaveBeenLastCalledWith(new TFile(`${folder}/canvases/${first.canvas}/lod.json`));
  });
});
