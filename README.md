# Canvas Precomputed LOD

Open image-heavy Obsidian Canvas boards with small previews, then load higher resolutions as you zoom on desktop or mobile.

The Python processor generates image variants and rewrites canvas references. Sync these files with your vault. The plugin then switches resolutions as you zoom without saving those runtime changes.

## Install

You need Obsidian 1.6+, Python 3.11+, and [uv](https://docs.astral.sh/uv/getting-started/installation/).

1. Install the [development dependencies](#development), then run `just install "/path/to/vault"`. This builds the plugin into an existing vault's `.obsidian/plugins/canvas-precomputed-lod/` and preserves its settings. Relative vault paths resolve from your current directory.
2. Enable **Canvas Precomputed LOD** in **Settings → Community plugins**.
3. Match the plugin's **LOD folder** to the processor's `--lod-dir` (default: `attachments/lod`).
4. Sync the generated files, plugin files, and settings to your other devices, then enable the plugin on each device. The generated files count toward your sync storage.

Alternatively, copy `dist/canvas-precomputed-lod` into `.obsidian/plugins/`, or run `just package` and unzip `canvas-precomputed-lod-plugin.zip` there.

## Prepare a vault

Install `obsidian-prepare-lods` from this checkout. uv manages Python and its dependencies:

```sh
uv tool install .
```

You can then run it from any directory. If it is missing from `PATH`, run `uv tool update-shell` and restart your shell.

Close Obsidian, let sync finish, and pause syncing until processing completes. Preview the changes before applying them:

```sh
obsidian-prepare-lods /path/to/vault --dry-run
obsidian-prepare-lods /path/to/vault
```

Custom settings:

```sh
obsidian-prepare-lods /path/to/vault \
  --lod-dir attachments/lod \
  --sizes 500,1000,2000 \
  --quality 85 \
  --workers 4
```

The defaults match the example: 500 / 1000 / 2000 pixels on the longest edge, WebP quality 85, and up to four workers. The worker count is limited by the number of CPUs and images.

- `--lod-dir` must be a visible folder relative to the vault.
- `--sizes` takes three distinct integers in ascending order, from 1 to 16383.
- Quality ranges from 1 to 100.
- `--workers` takes a positive integer. Fewer workers use less memory; `--workers 1` runs serially.

New boards qualify for processing when they have more than 16 MiB of distinct local file-card attachments, including non-images. Processed boards remain eligible after renaming. The processor prepares only originals above 512 KiB and reverts cards to their originals at or below that cutoff. These limits are in `src/obsidian_prepare_lods/processor.py`.

The processor supports static PNG, JPEG, WebP, BMP, AVIF, and single-frame GIF file cards. It skips animation, SVG, remote images, group backgrounds, and Markdown/text embeds. It preserves originals, aspect ratio, transparency, EXIF orientation, other node fields, and edges, though canvas JSON formatting may change.

The processor generates only tiers smaller than the original. A 1500-pixel image gets 500 and 1000; images at or below 500 stay unchanged.

Rerun after adding cards or editing images. The processor reuses shared assets, regenerates changed images, and repairs missing or corrupt variants. If an original becomes animated, it replaces its previews. Unchanged reruns and dry runs write nothing.

Exit codes: `0` success, `1` processing errors, `2` invalid arguments/setup.

Terminal output dims detailed progress and colors informational messages cyan, successful results green, skips yellow, and errors red. The final line reports the processing totals. Redirected output stays plain by default. Use `--color always` to force color or `--color never` to disable it. Auto mode also respects nonempty `NO_COLOR` and `TERM=dumb`.

## Layout and recovery

```text
attachments/lod/
  assets/<asset-id>/500.webp
  assets/<asset-id>/1000.webp
  assets/<asset-id>/2000.webp
  canvases/Boards/Example.canvas/lod.json
.canvas-lod-backups/<run-id>/Boards/Example.canvas
```

The plugin caches manifests across views until they change. Old assets and mappings remain to support delayed sync and interrupted runs; cleanup is manual.

Allow space for staged variants, manifests, backups, and canvas rewrites. Preparation or validation errors leave the vault unchanged. The processor skips unsupported images, but missing originals, invalid manifests, or broken provenance block changes. It never uses generated images as originals, even without metadata.

The processor writes variants, manifests, exact canvas backups, then canvas rewrites, in that order. Each replacement is atomic, but the whole run is not. Interruptions may leave unused outputs or partially updated boards. You can safely rerun the processor. Concurrent-edit checks do not lock out Obsidian or sync.

To undo, stop Obsidian and sync, then restore the backed-up `.canvas`. Hidden backups may not sync. Keep generated assets while any canvas references them.

After moving or renaming a canvas, rerun the processor to recover mappings. If you move an original, restore its path or repair the manifest or reference first. Choose the output folder before processing: moving generated folders or assets is unsupported.

## Runtime behavior and limits

- Visible managed cards use the smallest synced tier that covers displayed size × device pixel ratio × 1.15. Above the largest tier, they use the original.
- Upgrades wait until 200 ms after gestures end. Downshifts can occur during movement, with 20% hysteresis. The plugin limits work per frame. Each view preloads at most two images concurrently and shares loads for repeated cards.
- Missing metadata or failed loads leave the current image in place. If a saved preview is missing, the plugin can use another available tier. Relevant file events trigger retries, and the plugin batches sync bursts per view.
- Disabling the plugin restores saved previews. Opening an image uses the saved LOD reference. Native exports may lack full resolution. High zoom can load large originals, and memory has no hard cap.
- Canvas has no stable public rendering API. Obsidian updates, themes, or plugins may require changes to `src/canvas-dom.ts`.

To tune runtime behavior, edit `src/constants.ts` and rebuild. Configure generated tiers with `--sizes`.

## Development

Install dependencies and hooks:

```sh
uv sync --locked
npm ci --ignore-scripts
uv run pre-commit install
```

`uv sync` installs an editable Python package. You can run changes from the checkout with `uv run obsidian-prepare-lods /path/to/vault --dry-run` or `uv run python -m obsidian_prepare_lods` without reinstalling.

`uv build` creates the processor wheel and source distribution, including the license and Pillow dependency declaration. Install with `uv tool install dist/obsidian_prepare_lods-0.1.0-py3-none-any.whl`.

`just lint` or `uv run pre-commit run --all-files` checks file hygiene, Ruff, basedpyright, Biome, and TypeScript, excluding generated `dist/` files.

```sh
npm run build
uv run python -m unittest discover -s tests -p 'test_*.py' -v
uv run npm test
```

Each build checks types and runtime imports and writes to `dist/`. Tests use temporary vaults. `uv run` supplies Python for subprocesses; `LOD_PYTHON` overrides it for TypeScript and browser tests.

After building, `uv run python scripts/package.py` (or `just package`) creates verified, Git-ignored ZIPs for the plugin and source. They include `LICENSE` and exclude dependencies and caches. The plugin needs only `main.js`, `manifest.json`, `styles.css`, and `LICENSE`.

Browser fixtures:

```sh
node node_modules/playwright-core/cli.js install chromium webkit
uv run npm run test:browser
```

Localhost fixtures cover desktop and mobile sizes, high DPI, loading, gestures, zoom, rebuilt nodes, restoration, and errors in Chromium and WebKit. Screenshots go to `LOD_EVIDENCE_DIR` or a temporary directory whose path is printed.

Also check your Obsidian desktop/iOS version and theme in a disposable vault:

1. Transparent, rotated, repeated, and large images retain appearance and layout.
2. Zoom switches tiers; a long pinch upgrades after release without changing saved JSON.
3. Multiple views, pane switches, resizing, and reopening work; disabling restores previews.
4. Delayed manifests/variants preserve previews and recover after sync.
5. Renaming a canvas and rerunning restores switching; backups restore correctly.
