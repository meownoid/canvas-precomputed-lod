import { build } from 'esbuild';
import { chromium, webkit } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Browser plugin is not available. Use isolated Playwright engines and synthetic vault data.
// Flow: processed canvas opens small -> zoom upgrades -> zoom out downgrades -> unload restores saved sources.
const temp = await mkdtemp(join(tmpdir(), 'canvas-lod-browser-'));
const vault = join(temp, 'vault');
const evidence = process.env.LOD_EVIDENCE_DIR || join(temp, 'evidence');
await mkdir(evidence, { recursive: true });
const python = process.env.LOD_PYTHON || 'python3';
execFileSync(python, ['tests/browser_fixture.py', vault], { stdio: 'inherit' });
execFileSync(python, ['-m', 'obsidian_prepare_lods', vault], { stdio: 'inherit' });
const bundle = await build({ entryPoints: ['tests/browser-entry.ts'], bundle: true, format: 'esm', platform: 'browser', write: false });
const requests = [];
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Canvas LOD browser fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;background:#101923;color:#e8edf5;font:15px system-ui}header{padding:20px;border-bottom:1px solid #2d3d50}h1{font-size:20px;margin:0 0 10px}button{margin-right:8px;padding:8px 12px;background:#253b50;color:white;border:1px solid #536c81;border-radius:5px}#root{position:relative;width:100vw;height:65vh;overflow:hidden;background-image:radial-gradient(#344659 1px,transparent 1px);background-size:20px 20px}.canvas-wrapper{position:absolute;inset:0;overflow:hidden}.canvas{position:absolute;left:30px;top:30px;transform-origin:0 0}.canvas-node{width:600px;height:300px;border-radius:8px;overflow:hidden;outline:2px solid #688a9e}.canvas-node-content{width:600px;height:300px;display:flex;align-items:center;justify-content:center}.image-embed{display:flex;align-items:center;justify-content:center;width:100%;height:100%}img{max-width:100%;max-height:100%;object-fit:contain}footer{padding:20px;color:#a8b9c9}
</style></head><body><header><h1>Canvas Precomputed LOD — browser fixture</h1><button id="small">Zoom out</button><button id="large">Full detail</button><span id="scale">20%</span></header><div id="root"></div><footer>Synthetic image. Runtime changes only the displayed source.</footer><script type="module" src="/fixture.js"></script></body></html>`;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  requests.push(path);
  if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
  if (path === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }).end(html); return; }
  if (path === '/fixture.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents); return; }
  try {
    const file = resolve(vault, '.' + decodeURIComponent(path));
    if (!file.startsWith(vault + '/')) throw new Error('outside fixture');
    const type = { '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json' }[extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const results = [];
try {
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const mobile of [false, true]) {
        requests.length = 0;
        const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1100, height: 760 }, deviceScaleFactor: mobile ? 3 : 1, isMobile: mobile, hasTouch: mobile });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.goto(origin);
        await page.waitForFunction(() => document.body.dataset.ready === 'true');
        assert.equal(await page.title(), 'Canvas LOD browser fixture');
        await page.waitForFunction(() => document.querySelector('#root img')?.style.width === '600px');
        assert.equal(requests.filter(path => path === '/photo.png').length, 0, 'initial opening requested original');
        await page.evaluate(async () => { window.lodTest.secondView(); await window.lodTest.metadata(); });
        assert.equal(requests.filter(path => path.endsWith('/lod.json')).length, 1, 'metadata was not shared');
        await page.screenshot({ path: join(evidence, `${engineName}-${mobile ? 'mobile' : 'desktop'}-small.png`) });
        // Hold two pointers past the old 200ms timeout; originals must remain unloaded.
        await page.evaluate(() => {
          const root = document.querySelector('#root');
          root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
          root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }));
          window.lodTest.zoom(5);
        });
        await page.waitForTimeout(350);
        assert.equal(requests.filter(path => path === '/photo.png').length, 0, 'upgrade happened mid-pinch');
        await page.evaluate(() => {
          window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
          window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }));
        });
        await page.waitForFunction(() => document.querySelector('#root img').getAttribute('src') === window.lodTest.original);
        await page.screenshot({ path: join(evidence, `${engineName}-${mobile ? 'mobile' : 'desktop'}-detail.png`) });
        await page.locator('#small').click();
        await page.waitForFunction(() => !document.querySelector('#root img').getAttribute('src').endsWith('photo.png'));
        await page.evaluate(() => { window.lodTest.replaceBoard(); window.lodTest.zoom(5); });
        await page.waitForFunction(() => document.querySelector('#root img').getAttribute('src') === window.lodTest.original);
        const firstChunk = await page.evaluate(async () => {
          window.lodTest.populate(240);
          // Let the mutation observer schedule the binding before observing its first frame.
          await Promise.resolve();
          return new Promise(resolve => requestAnimationFrame(() => {
            resolve([...document.querySelectorAll('#root img')].filter(img => img.style.width === '600px').length);
          }));
        });
        assert.ok(firstChunk > 0 && firstChunk < 240, `canvas scan did not yield: ${firstChunk}/240 cards`);
        await page.waitForFunction(() => [...document.querySelectorAll('#root img')].every(img => img.style.width === '600px'));
        await page.evaluate(() => window.lodTest.zoom(5));
        await page.waitForFunction(() => document.querySelector('#root img').getAttribute('src') === window.lodTest.original);
        await page.evaluate(() => window.lodTest.unload());
        assert.equal(await page.locator('#root img').first().getAttribute('src'), await page.evaluate(() => window.lodTest.smallest));
        assert.deepEqual(errors, [], 'browser console/runtime errors');
        results.push({ engine: engineName, viewport: mobile ? '390x844 @3x' : '1100x760 @1x', firstChunk, checks: 'PASS: initial requests, one manifest read, long pinch, upgrade/downgrade, DOM replacement, chunked scan, unload, console' });
        await context.close();
      }
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify({ results, evidence }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  // Evidence is retained when a caller supplies LOD_EVIDENCE_DIR.
  if (process.env.LOD_EVIDENCE_DIR) await rm(temp, { recursive: true, force: true });
}
