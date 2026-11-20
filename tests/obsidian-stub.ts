export class TFile {
  constructor(public path: string) {}
}
export class Plugin {
  cleanups: Array<() => void> = [];
  constructor(public app: any, public manifest: any) {}
  async loadData() { return null; }
  async saveData(_value: unknown) {}
  registerEvent(event: { off(): void }) { this.cleanups.push(() => event.off()); }
  registerInterval(id: number) { this.cleanups.push(() => window.clearInterval(id)); }
  addSettingTab(_tab: unknown) {}
  dispose() { for (const cleanup of this.cleanups) cleanup(); }
}
export class PluginSettingTab {
  containerEl = document.createElement('div');
  constructor(public app: any, public plugin: any) {}
}
export class Setting {
  constructor(_container: HTMLElement) {}
  setName(_name: string) { return this; }
  setDesc(_description: string) { return this; }
  addText(_callback: unknown) { return this; }
}
