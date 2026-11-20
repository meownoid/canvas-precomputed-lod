import { Plugin, PluginSettingTab, Setting, TFile, type WorkspaceLeaf } from 'obsidian';
import { CanvasBinding, loadBrowserImage } from './canvas-dom';
import { ManifestCache } from './manifest-cache';
import { DEFAULT_LOD_DIR, lodFolder, manifestPath } from './model';
import { FILE_REFRESH_DELAY_MS, VIEW_POLL_INTERVAL_MS } from './constants';

interface Settings { lodDir: string }
interface BoundView { path: string; root: HTMLElement; binding: CanvasBinding }

export default class CanvasPrecomputedLod extends Plugin {
  settings: Settings = { lodDir: DEFAULT_LOD_DIR };
  private cache!: ManifestCache;
  private bindings = new Map<WorkspaceLeaf, BoundView>();
  private active = false;
  private pendingRefreshes = new Set<CanvasBinding>();
  private refreshTimer: number | undefined;

  async onload(): Promise<void> {
    this.active = true;
    const stored = await this.loadData() as Partial<Settings> | null;
    try { this.settings.lodDir = lodFolder(stored?.lodDir ?? DEFAULT_LOD_DIR); } catch { /* Use valid defaults. */ }
    this.cache = new ManifestCache({ readText: async path => {
      const file = this.app.vault.getAbstractFileByPath(path);
      return file instanceof TFile ? this.app.vault.cachedRead(file) : null;
    } }, this.settings.lodDir);
    this.addSettingTab(new LodSettingsTab(this.app, this));
    const refresh = (): void => {
      this.refreshViews();
      for (const entry of this.bindings.values()) entry.binding.schedule();
    };
    this.registerEvent(this.app.workspace.on('layout-change', refresh));
    this.registerEvent(this.app.workspace.on('active-leaf-change', refresh));
    this.registerEvent(this.app.workspace.on('file-open', refresh));
    this.registerEvent(this.app.workspace.on('resize', refresh));
    this.registerEvent(this.app.vault.on('create', file => this.fileChanged(file.path)));
    this.registerEvent(this.app.vault.on('modify', file => this.fileChanged(file.path)));
    this.registerEvent(this.app.vault.on('delete', file => this.fileChanged(file.path)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { this.fileChanged(oldPath); this.fileChanged(file.path); this.refreshViews(); }));
    this.app.workspace.onLayoutReady(refresh);
    // Deferred canvas leaves can become ready without changing the active pane.
    this.registerInterval(window.setInterval(() => this.refreshViews(), VIEW_POLL_INTERVAL_MS));
  }

  private fileChanged(path: string): void {
    // Also invalidate closed canvases, so their next view does not reuse stale/missing metadata.
    const prefix = `${this.settings.lodDir}/canvases/`;
    if (path.startsWith(prefix) && path.endsWith('/lod.json')) {
      this.cache.invalidate(path.slice(prefix.length, -'/lod.json'.length));
    } else if (path.startsWith(prefix) || prefix.startsWith(`${path}/`)) {
      // Folder rename/delete events can stand in for events on their descendants.
      this.cache.clear();
    }
    for (const entry of this.bindings.values()) {
      const metadata = manifestPath(this.settings.lodDir, entry.path);
      if (path === metadata || metadata.startsWith(`${path}/`) || entry.binding.references(path)) {
        this.pendingRefreshes.add(entry.binding);
      }
    }
    if (!this.pendingRefreshes.size || this.refreshTimer !== undefined) return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      const pending = [...this.pendingRefreshes];
      this.pendingRefreshes.clear();
      for (const binding of pending) void binding.refresh();
    }, FILE_REFRESH_DELAY_MS);
  }

  private cancelPendingRefreshes(): void {
    if (this.refreshTimer !== undefined) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.pendingRefreshes.clear();
  }

  private refreshViews(): void {
    if (!this.active) return;
    const leaves = new Set(this.app.workspace.getLeavesOfType('canvas'));
    for (const [leaf, entry] of this.bindings) {
      const view = leaf.view as unknown as { file?: TFile; contentEl?: HTMLElement };
      if (!leaves.has(leaf) || view.file?.path !== entry.path || view.contentEl !== entry.root) {
        entry.binding.stop(); this.bindings.delete(leaf);
      }
    }
    for (const leaf of leaves) {
      if (this.bindings.has(leaf)) continue;
      const view = leaf.view as unknown as { file?: TFile; contentEl?: HTMLElement };
      const path = view.file?.path, root = view.contentEl;
      if (!path || !root || typeof root.querySelector !== 'function') continue;
      const binding = new CanvasBinding(root, {
        getManifest: () => this.cache.get(path),
        resource: relative => {
          const file = this.app.vault.getAbstractFileByPath(relative);
          return {
            url: file instanceof TFile ? this.app.vault.getResourcePath(file) : this.app.vault.adapter.getResourcePath(relative),
            available: file instanceof TFile,
          };
        },
        loadImage: url => loadBrowserImage(url, root.ownerDocument.defaultView!),
      });
      this.bindings.set(leaf, { path, root, binding });
    }
  }

  async setFolder(folder: string): Promise<void> {
    const lodDir = lodFolder(folder);
    await this.saveData({ lodDir });
    this.settings.lodDir = lodDir;
    this.cancelPendingRefreshes();
    for (const entry of this.bindings.values()) entry.binding.stop();
    this.bindings.clear(); this.cache.clear(this.settings.lodDir); this.refreshViews();
  }

  onunload(): void {
    this.active = false;
    this.cancelPendingRefreshes();
    for (const entry of this.bindings.values()) entry.binding.stop();
    this.bindings.clear(); this.cache.clear();
  }
}

class LodSettingsTab extends PluginSettingTab {
  constructor(app: Plugin['app'], private plugin: CanvasPrecomputedLod) { super(app, plugin); }
  display(): void {
    this.containerEl.empty();
    const setting = new Setting(this.containerEl).setName('LOD folder').setDesc('Vault-relative folder used by obsidian-prepare-lods.');
    setting.addText(text => {
      text.setPlaceholder(DEFAULT_LOD_DIR).setValue(this.plugin.settings.lodDir);
      text.inputEl.addEventListener('change', () => {
        void this.plugin.setFolder(text.getValue().trim()).then(() => {
          setting.setDesc('Vault-relative folder used by obsidian-prepare-lods.');
        }, error => { setting.setDesc(String(error)); });
      });
    });
  }
}
