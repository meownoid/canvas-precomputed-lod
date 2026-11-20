"""Package already-built plugin and source, excluding local dependencies and caches."""

import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
plugin = root / "dist" / "canvas-precomputed-lod"
required = {"main.js", "manifest.json", "styles.css", "LICENSE"}
if not all((plugin / name).is_file() for name in required):
    raise SystemExit("Run npm run build first; expected the four plugin distribution files")
source_files = [
    p
    for p in root.rglob("*")
    if p.is_file()
    and not any(
        part in {"node_modules", "__pycache__", ".venv", ".git", "coverage", ".browser-test", ".ruff_cache"}
        for part in p.relative_to(root).parts
    )
    and p.suffix not in {".zip", ".whl"}
    and not p.name.endswith(".tar.gz")
    and p.name != ".DS_Store"
]
outputs = [root / "canvas-precomputed-lod-plugin.zip", root / "canvas-precomputed-lod-source.zip"]
with zipfile.ZipFile(outputs[0], "w", zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(required):
        archive.write(plugin / name, "canvas-precomputed-lod/" + name)
with zipfile.ZipFile(outputs[1], "w", zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(source_files):
        archive.write(path, "canvas-precomputed-lod/" + path.relative_to(root).as_posix())
for path in outputs:
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise SystemExit(f"Archive verification failed: {path.name}")
    print(f"PACKAGED {path.name} ({path.stat().st_size} bytes)")
