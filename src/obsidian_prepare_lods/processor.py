"""Prepare portable image LODs for Obsidian Canvas. Originals are never changed."""

from __future__ import annotations

import hashlib
import io
import json
import multiprocessing
import os
import re
import sys
import tempfile
import uuid
import warnings
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image, ImageOps, features

from .terminal import MessageType, TerminalOutput, format_size

GENERATOR = "canvas-precomputed-lod"
VERSION = 1
DEFAULT_SIZES = (500, 1000, 2000)
DEFAULT_WORKERS = min(4, os.cpu_count() or 1)
MIN_CANVAS_BYTES = 16 * 1024 * 1024
MIN_IMAGE_BYTES = 512 * 1024
RASTER_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".avif", ".gif"}


class ProcessingError(ValueError):
    pass


class SkipImage(ValueError):
    pass


def vault_path(value: Any) -> str:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ProcessingError("expected a nonempty, vault-relative POSIX path")
    p = PurePosixPath(value)
    if p.is_absolute() or any(part in {"", ".", ".."} for part in value.split("/")) or ":" in value:
        raise ProcessingError(f"unsafe vault path: {value!r}")
    return value


def positive_int(value: Any) -> int:
    if type(value) is not int or not 0 < value <= 2**53 - 1:
        raise ProcessingError("dimensions and target sizes must be positive integers")
    return value


def short_hash(data: bytes) -> str:
    """Use the first 128 bits of SHA-256 for fingerprints and asset IDs."""
    return hashlib.sha256(data).hexdigest()[:32]


def generated_path(path: str) -> bool:
    return re.search(r"(?:^|/)assets/[0-9a-f]{32}/[0-9]+\.webp$", path) is not None


def json_bytes(value: Any, indent: str | int = 2) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=indent, allow_nan=False) + "\n").encode("utf-8")


def parse_json(data: bytes | str) -> Any:
    def reject_constant(value: str) -> None:
        raise ProcessingError(f"invalid JSON constant: {value}")

    return json.loads(data, parse_constant=reject_constant)


@dataclass(frozen=True)
class Settings:
    sizes: tuple[int, int, int] = DEFAULT_SIZES
    quality: int = 85

    def __post_init__(self) -> None:
        if len(self.sizes) != 3 or tuple(sorted(set(self.sizes))) != self.sizes:
            raise ProcessingError("--sizes requires exactly three distinct ascending integers")
        if any(type(n) is not int or not 1 <= n <= 16383 for n in self.sizes):
            raise ProcessingError("target sizes must be between 1 and 16383")
        if type(self.quality) is not int or not 1 <= self.quality <= 100:
            raise ProcessingError("quality must be between 1 and 100")

    def to_json(self) -> dict[str, Any]:
        return {"sizes": list(self.sizes), "quality": self.quality, "format": "webp", "algorithm": 1}

    @classmethod
    def parse(cls, raw: Any) -> Settings:
        if (
            not isinstance(raw, dict)
            or raw.get("format") != "webp"
            or type(raw.get("algorithm")) is not int
            or raw.get("algorithm") != 1
        ):
            raise ProcessingError("unsupported generation settings")
        sizes = raw.get("sizes")
        if not isinstance(sizes, list):
            raise ProcessingError("invalid target sizes")
        return cls(tuple(sizes), raw.get("quality"))  # type: ignore[arg-type]


@dataclass(frozen=True)
class Variant:
    path: str
    width: int
    height: int
    target: int

    def to_json(self) -> dict[str, Any]:
        return {"path": self.path, "width": self.width, "height": self.height, "target": self.target}


@dataclass(frozen=True)
class Asset:
    original: str
    width: int
    height: int
    fingerprint: str
    settings: Settings
    variants: tuple[Variant, ...]

    @property
    def asset_id(self) -> str:
        payload = [self.original, self.fingerprint, self.settings.to_json()]
        return short_hash(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))

    def to_json(self) -> dict[str, Any]:
        return {
            "original": {
                "path": self.original,
                "width": self.width,
                "height": self.height,
                "fingerprint": self.fingerprint,
            },
            "settings": self.settings.to_json(),
            "variants": [v.to_json() for v in self.variants],
        }

    @classmethod
    def parse(cls, asset_id: str, raw: Any, lod_dir: str) -> Asset:
        if not isinstance(raw, dict) or not isinstance(raw.get("original"), dict):
            raise ProcessingError("invalid asset")
        source = raw["original"]
        original = vault_path(source.get("path"))
        if original == lod_dir or original.startswith(lod_dir + "/") or generated_path(original):
            raise ProcessingError("an original cannot be a generated asset")
        width, height = positive_int(source.get("width")), positive_int(source.get("height"))
        fingerprint = source.get("fingerprint")
        if not isinstance(fingerprint, str) or not re.fullmatch(r"[0-9a-f]{32}", fingerprint):
            raise ProcessingError("invalid source fingerprint")
        settings = Settings.parse(raw.get("settings"))
        items = raw.get("variants")
        if not isinstance(items, list) or not 1 <= len(items) <= 3:
            raise ProcessingError("expected one to three variants")
        variants = []
        previous = 0
        for item in items:
            if not isinstance(item, dict):
                raise ProcessingError("invalid variant")
            path = vault_path(item.get("path"))
            w, h, target = (positive_int(item.get(k)) for k in ("width", "height", "target"))
            edge = max(w, h)
            if target not in settings.sizes or not previous < edge < max(width, height) or edge != target:
                raise ProcessingError("variants must be distinct, ascending downscales")
            if path != f"{lod_dir}/assets/{asset_id}/{target}.webp":
                raise ProcessingError("variant path does not match its asset")
            expected = dimensions(width, height, target)
            if (w, h) != expected:
                raise ProcessingError("variant aspect ratio does not match its source")
            variants.append(Variant(path, w, h, target))
            previous = edge
        asset = cls(original, width, height, fingerprint, settings, tuple(variants))
        if asset.asset_id != asset_id:
            raise ProcessingError("asset ID does not match its provenance")
        return asset


def dimensions(width: int, height: int, target: int) -> tuple[int, int]:
    # Explicit half-up rounding is shared with the TypeScript validator.
    edge = max(width, height)
    return max(1, int(width * target / edge + 0.5)), max(1, int(height * target / edge + 0.5))


@dataclass
class Manifest:
    canvas: str
    assets: dict[str, Asset] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "version": VERSION,
            "generator": GENERATOR,
            "canvas": self.canvas,
            "assets": {key: self.assets[key].to_json() for key in sorted(self.assets)},
        }

    @classmethod
    def parse(cls, raw: Any, lod_dir: str) -> Manifest:
        if (
            not isinstance(raw, dict)
            or type(raw.get("version")) is not int
            or raw["version"] != VERSION
            or raw.get("generator") != GENERATOR
        ):
            raise ProcessingError("unsupported LOD manifest")
        canvas = vault_path(raw.get("canvas"))
        if not canvas.endswith(".canvas") or not isinstance(raw.get("assets"), dict):
            raise ProcessingError("invalid canvas manifest")
        assets = {}
        for key, item in raw["assets"].items():
            if not re.fullmatch(r"[0-9a-f]{32}", key):
                raise ProcessingError("invalid asset ID")
            assets[key] = Asset.parse(key, item, lod_dir)
        return cls(canvas, assets)


def atomic_write(path: Path, data: bytes, before_replace: Callable[[], None] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".lod-tmp-", dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if path.exists():
            temp.chmod(path.stat().st_mode & 0o777)
        if before_replace:
            before_replace()
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


@dataclass
class Stats:
    scanned: int = 0
    changed: int = 0
    generated: int = 0
    reused: int = 0
    skipped: int = 0
    failed: int = 0


@dataclass(frozen=True)
class CanvasSnapshot:
    path: Path
    data: bytes
    raw: dict[str, Any]


@dataclass(frozen=True)
class PreparedImage:
    asset: Asset | None
    stats: Stats
    messages: tuple[tuple[MessageType, str], ...]
    error: Exception | None = None


def prepare_image(
    vault: Path,
    lod_dir: str,
    settings: Settings,
    dry_run: bool,
    original: str,
    known: tuple[Asset, ...],
    staging: Path | None,
    min_image_bytes: int,
) -> PreparedImage:
    # Each process owns its Pillow warning filters, image buffers, and counters.
    messages: list[tuple[MessageType, str]] = []
    processor = Processor(
        vault,
        lod_dir,
        settings,
        dry_run,
        log=lambda kind, message: messages.append((kind, message)),
        workers=1,
        staging=staging,
        min_image_bytes=min_image_bytes,
    )
    processor.known = {asset.asset_id: asset for asset in known}
    try:
        asset = processor.prepare(original)
    except (OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        return PreparedImage(None, processor.stats, tuple(messages), exc)
    return PreparedImage(asset, processor.stats, tuple(messages))


class Processor:
    def __init__(
        self,
        vault: Path,
        lod_dir: str = "attachments/lod",
        settings: Settings = Settings(),
        dry_run: bool = False,
        log: Callable[[MessageType, str], None] | None = None,
        *,
        workers: int = DEFAULT_WORKERS,
        staging: Path | None = None,
        min_canvas_bytes: int = MIN_CANVAS_BYTES,
        min_image_bytes: int = MIN_IMAGE_BYTES,
    ) -> None:
        if type(workers) is not int or workers < 1:
            raise ProcessingError("workers must be a positive integer")
        if any(type(size) is not int or size < 0 for size in (min_canvas_bytes, min_image_bytes)):
            raise ProcessingError("minimum file sizes must be nonnegative integers")
        self.vault = vault.resolve(strict=True)
        if not self.vault.is_dir():
            raise ProcessingError("vault must be a directory")
        self.lod_dir = vault_path(lod_dir)
        if any(part.startswith(".") for part in self.lod_dir.split("/")):
            raise ProcessingError("the LOD folder must be visible to Obsidian and sync")
        self.inside(self.lod_dir)
        self.settings, self.dry_run = settings, dry_run
        self.log = log if log is not None else TerminalOutput(sys.stdout, "never").log
        self.workers = workers
        self.staging = staging
        self.min_canvas_bytes = min_canvas_bytes
        self.min_image_bytes = min_image_bytes
        self.stats = Stats()
        self.manifests: dict[str, Manifest] = {}
        self.invalid_manifests: set[str] = set()
        self.known: dict[str, Asset] = {}
        self.aliases: dict[str, str] = {}
        self.conflicts: set[str] = set()
        self.prepared: dict[str, Asset | None] = {}
        self.preparation_errors: dict[str, Exception] = {}
        self.canvas_updates: list[CanvasSnapshot] = []
        self.run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]

    def inside(self, relative: str) -> Path:
        path = self.vault / vault_path(relative)
        if not path.resolve().is_relative_to(self.vault):
            raise ProcessingError(f"path leaves vault through a symlink: {relative}")
        return path

    def manifest_relative(self, canvas: str) -> str:
        return f"{self.lod_dir}/canvases/{canvas}/lod.json"

    def staged_path(self, relative: str) -> Path:
        self.inside(relative)
        if self.staging is None:
            raise ProcessingError("output must be prepared in a temporary directory")
        return self.staging / relative

    def error(self, context: str, error: Exception | str) -> None:
        self.stats.failed += 1
        self.log(MessageType.ERROR, f"{context}: {error}")

    def load_manifests(self) -> None:
        root = self.inside(f"{self.lod_dir}/canvases")
        if not root.exists():
            return
        for folder, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not d.startswith(".") and not (Path(folder) / d).is_symlink())
            if "lod.json" not in files:
                continue
            path = Path(folder) / "lod.json"
            relative = path.relative_to(self.vault).as_posix()
            try:
                self.inside(relative)
                manifest = Manifest.parse(parse_json(path.read_bytes()), self.lod_dir)
                if relative != self.manifest_relative(manifest.canvas):
                    raise ProcessingError("manifest canvas path does not match its location")
                self.manifests[manifest.canvas] = manifest
                for key, asset in manifest.assets.items():
                    prior = self.known.get(key)
                    if prior is not None and prior != asset:
                        raise ProcessingError("conflicting asset provenance")
                    self.known[key] = asset
                    for variant in asset.variants:
                        previous = self.aliases.get(variant.path)
                        if previous is not None and previous != asset.original:
                            self.conflicts.add(variant.path)
                        self.aliases[variant.path] = asset.original
            except (ValueError, OSError, TypeError) as exc:
                self.invalid_manifests.add(relative)
                self.error(relative, exc)

    def canvases(self) -> list[Path]:
        result = []
        for folder, dirs, files in os.walk(self.vault, followlinks=False):
            dirs[:] = sorted(
                d
                for d in dirs
                if not d.startswith(".")
                and not (Path(folder) / d).is_symlink()
                and (Path(folder) / d).relative_to(self.vault).as_posix() != self.lod_dir
            )
            result.extend(Path(folder) / name for name in sorted(files) if name.endswith(".canvas"))
        return result

    def variant_valid(self, variant: Variant) -> bool:
        try:
            path = self.inside(variant.path)
            if self.staging is not None and (self.staging / variant.path).exists():
                path = self.staging / variant.path
            with Image.open(path) as image:
                if (
                    image.format != "WEBP"
                    or image.size != (variant.width, variant.height)
                    or getattr(image, "n_frames", 1) != 1
                ):
                    return False
                # WebP verify() does not decode the payload, so damaged frames can pass it.
                image.load()
            return True
        except (OSError, ValueError):
            return False

    def prepare(self, original: str) -> Asset | None:
        if original in self.preparation_errors:
            raise self.preparation_errors[original]
        if original in self.prepared:
            return self.prepared[original]
        self.log(MessageType.DETAIL, f"Checking {original}")
        path = self.inside(original)
        if path.stat().st_size <= self.min_image_bytes:
            self.stats.skipped += 1
            self.prepared[original] = None
            self.log(MessageType.SKIP, f"{original}: file size is not greater than {format_size(self.min_image_bytes)}")
            return None
        source_bytes = path.read_bytes()
        fingerprint = short_hash(source_bytes)
        probe = Asset(original, 1, 1, fingerprint, self.settings, ())
        existing = self.known.get(probe.asset_id)
        if existing and all(self.variant_valid(v) for v in existing.variants):
            self.stats.reused += 1
            self.prepared[original] = existing
            self.log(MessageType.SUCCESS, f"Reused {original}")
            return existing
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(source_bytes)) as source:
                if getattr(source, "n_frames", 1) != 1:
                    self.stats.skipped += 1
                    self.prepared[original] = None
                    self.log(MessageType.SKIP, f"{original}: animated or multi-frame image")
                    return None
                oriented = ImageOps.exif_transpose(source)
                try:
                    width, height = oriented.size
                    targets = [t for t in self.settings.sizes if t < max(width, height)]
                    if not targets:
                        self.prepared[original] = None
                        self.log(MessageType.SKIP, f"{original}: no downscaling needed")
                        return None
                    alpha = "A" in oriented.getbands() or "transparency" in oriented.info
                    image = oriented.convert("RGBA" if alpha else "RGB")
                    try:
                        asset = Asset(
                            original,
                            width,
                            height,
                            fingerprint,
                            self.settings,
                            tuple(
                                Variant(
                                    f"{self.lod_dir}/assets/{probe.asset_id}/{target}.webp",
                                    *dimensions(width, height, target),
                                    target,
                                )
                                for target in targets
                            ),
                        )
                        for variant in asset.variants:
                            if self.variant_valid(variant):
                                continue
                            self.log(
                                MessageType.INFO,
                                f"{'Would generate' if self.dry_run else 'Generating'} "
                                f"{variant.path} ({variant.width}x{variant.height})",
                            )
                            if not self.dry_run:
                                resized = image.resize((variant.width, variant.height), Image.Resampling.LANCZOS)
                                try:
                                    out = io.BytesIO()
                                    options: dict[str, Any] = {
                                        "format": "WEBP",
                                        "quality": self.settings.quality,
                                        "method": 6,
                                    }
                                    if oriented.mode in {"RGB", "RGBA"} and oriented.info.get("icc_profile"):
                                        options["icc_profile"] = oriented.info["icc_profile"]
                                    resized.save(out, **options)
                                    atomic_write(self.staged_path(variant.path), out.getvalue())
                                finally:
                                    resized.close()
                            self.stats.generated += 1
                    finally:
                        image.close()
                finally:
                    oriented.close()
        self.prepared[original] = asset
        self.known[asset.asset_id] = asset
        return asset

    def write_if_changed(self, relative: str, data: bytes) -> None:
        path = self.inside(relative)
        if not path.exists() or path.read_bytes() != data:
            if not self.dry_run:
                atomic_write(self.staged_path(relative), data)

    def original_path(self, file: Any) -> str:
        if isinstance(file, str) and "://" in file:
            raise SkipImage("remote image")
        path = vault_path(file)
        if path in self.conflicts:
            raise ProcessingError("ambiguous provenance")
        original = self.aliases.get(path, path)
        if original.startswith(self.lod_dir + "/") or generated_path(original):
            raise ProcessingError("generated file has no valid provenance; refusing recursive processing")
        if PurePosixPath(original).suffix.lower() not in RASTER_EXTENSIONS:
            raise SkipImage("not a supported local raster image")
        return original

    def select_canvas(self, relative: str, raw: dict[str, Any]) -> bool:
        if relative in self.manifests or self.min_canvas_bytes == 0:
            return True
        attachments = set()
        for node in raw.get("nodes", []):
            if not isinstance(node, dict) or node.get("type") != "file":
                continue
            file = node.get("file")
            if not isinstance(file, str) or "://" in file:
                continue
            # Recognize moved boards and report broken provenance even when a manifest is missing.
            if file in self.aliases or file.startswith(self.lod_dir + "/") or generated_path(file):
                return True
            attachments.add(file)
        total = 0
        for attachment in sorted(attachments):
            try:
                total += self.inside(attachment).stat().st_size
            except (OSError, ValueError):
                # Reference errors are reported with their node context if the board qualifies.
                continue
        if total > self.min_canvas_bytes:
            return True
        self.stats.skipped += 1
        self.log(
            MessageType.SKIP,
            f"{relative}: attachments total {format_size(total)} is not greater than {format_size(self.min_canvas_bytes)}",
        )
        return False

    def read_canvas(self, path: Path) -> CanvasSnapshot | None:
        relative = path.relative_to(self.vault).as_posix()
        self.stats.scanned += 1
        self.log(MessageType.INFO, f"Reading canvas {relative}")
        if path.is_symlink():
            self.error(relative, "symlinked canvases are not rewritten")
            return
        manifest_relative = self.manifest_relative(relative)
        if manifest_relative in self.invalid_manifests:
            self.log(MessageType.SKIP, f"{relative}: repair its invalid manifest first")
            return
        snapshot = path.read_bytes()
        raw = parse_json(snapshot)
        if not isinstance(raw, dict) or ("nodes" in raw and not isinstance(raw["nodes"], list)):
            raise ProcessingError("canvas must be an object with an optional nodes array")
        if not self.select_canvas(relative, raw):
            return None
        return CanvasSnapshot(path, snapshot, raw)

    def prepare_images(self, canvases: list[CanvasSnapshot]) -> None:
        if self.workers == 1:
            return
        originals: dict[str, None] = {}
        for canvas in canvases:
            for node in canvas.raw.get("nodes", []):
                if not isinstance(node, dict) or node.get("type") != "file":
                    continue
                try:
                    originals[self.original_path(node.get("file"))] = None
                except ValueError:
                    # Report invalid references with their node context during the commit pass.
                    continue
        if len(originals) < 2:
            return
        known: dict[str, list[Asset]] = {}
        for asset in self.known.values():
            known.setdefault(asset.original, []).append(asset)
        workers = min(self.workers, len(originals))
        self.log(MessageType.INFO, f"Preparing {len(originals)} unique image(s) with {workers} worker processes")
        with ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn")) as pool:
            pending = {}
            for original in originals:
                self.log(MessageType.DETAIL, f"Queued {original}")
                future = pool.submit(
                    prepare_image,
                    self.vault,
                    self.lod_dir,
                    self.settings,
                    self.dry_run,
                    original,
                    tuple(known.get(original, ())),
                    self.staging,
                    self.min_image_bytes,
                )
                pending[future] = original
            for completed, future in enumerate(as_completed(pending), 1):
                original = pending[future]
                result = future.result()
                self.stats.generated += result.stats.generated
                self.stats.reused += result.stats.reused
                self.stats.skipped += result.stats.skipped
                for kind, message in result.messages:
                    self.log(kind, message)
                progress = f"{original} ({completed}/{len(originals)})"
                if result.error is not None:
                    self.preparation_errors[original] = result.error
                    self.log(MessageType.ERROR, f"Failed to prepare {progress}")
                else:
                    self.prepared[original] = result.asset
                    if result.asset is not None:
                        self.known[result.asset.asset_id] = result.asset
                    self.log(MessageType.SUCCESS, f"Finished preparing {progress}")

    def process_canvas(self, canvas: CanvasSnapshot) -> None:
        path, snapshot = canvas.path, canvas.data
        relative = path.relative_to(self.vault).as_posix()
        manifest_relative = self.manifest_relative(relative)
        updated = deepcopy(canvas.raw)
        prior = self.manifests.get(relative)
        manifest = Manifest(relative, dict(prior.assets) if prior else {})
        changed = False
        for node in updated.get("nodes", []):
            if not isinstance(node, dict):
                self.error(relative, "invalid canvas node; node left unchanged")
                continue
            if node.get("type") != "file":
                if node.get("type") in {"text", "link"} or node.get("background"):
                    self.log(MessageType.SKIP, f"{relative} node {node.get('id', '?')}: not an image file card")
                continue
            try:
                original = self.original_path(node.get("file"))
                asset = self.prepare(original)
                replacement = asset.variants[0].path if asset else original
                if asset:
                    manifest.assets[asset.asset_id] = asset
                if replacement != node["file"]:
                    node["file"] = replacement
                    changed = True
            except SkipImage as exc:
                self.stats.skipped += 1
                self.log(MessageType.SKIP, f"{relative} node {node.get('id', '?')}: {exc}")
            except (OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
                self.error(f"{relative} node {node.get('id', '?')}", exc)
        # Retain historical mappings so existing references survive an interrupted apply.
        if manifest.assets:
            self.write_if_changed(manifest_relative, json_bytes(manifest.to_json()))
        if not changed:
            return
        if not self.dry_run:
            backup = self.staged_path(f".canvas-lod-backups/{self.run_id}/{relative}")
            atomic_write(backup, snapshot)
            match = re.search(rb"\n([ \t]+)\S", snapshot)
            indent = match.group(1).decode() if match else 2
            atomic_write(self.staged_path(relative), json_bytes(updated, indent))
        self.canvas_updates.append(canvas)
        self.log(MessageType.INFO, f"{'Would rewrite' if self.dry_run else 'Staged'} {relative}")

    def check_canvas_unchanged(self, canvas: CanvasSnapshot) -> None:
        relative = canvas.path.relative_to(self.vault).as_posix()
        path = self.inside(relative)
        if path.is_symlink() or path.read_bytes() != canvas.data:
            raise ProcessingError(f"{relative}: canvas changed during processing; refusing to overwrite it")

    def validate_prepared(self, canvases: list[CanvasSnapshot]) -> None:
        self.log(MessageType.INFO, "Validating staged output and current vault inputs")
        for canvas in canvases:
            self.check_canvas_unchanged(canvas)
        for asset in self.prepared.values():
            if asset is None:
                continue
            if short_hash(self.inside(asset.original).read_bytes()) != asset.fingerprint:
                raise ProcessingError(f"{asset.original}: original changed during processing")
            for variant in asset.variants:
                if not self.variant_valid(variant):
                    raise ProcessingError(f"{variant.path}: prepared variant is missing or invalid")
        root = self.staged_path(f"{self.lod_dir}/canvases")
        for path in root.rglob("lod.json"):
            Manifest.parse(parse_json(path.read_bytes()), self.lod_dir)

    def apply_prepared(self) -> None:
        self.log(MessageType.INFO, "Applying staged assets, manifests, backups, then canvases")
        for relative in (f"{self.lod_dir}/assets", f"{self.lod_dir}/canvases", f".canvas-lod-backups/{self.run_id}"):
            root = self.staged_path(relative)
            for source in sorted(root.rglob("*")):
                if source.is_file():
                    assert self.staging is not None
                    destination = source.relative_to(self.staging).as_posix()
                    atomic_write(self.inside(destination), source.read_bytes())
        for canvas in self.canvas_updates:
            relative = canvas.path.relative_to(self.vault).as_posix()
            self.check_canvas_unchanged(canvas)
            atomic_write(
                self.inside(relative),
                self.staged_path(relative).read_bytes(),
                before_replace=lambda: self.check_canvas_unchanged(canvas),
            )
            self.stats.changed += 1
            self.log(MessageType.SUCCESS, f"Rewrote {relative}")

    def run(self) -> Stats:
        if not features.check("webp"):
            raise ProcessingError("Pillow was built without WebP support")
        self.log(
            MessageType.INFO,
            f"Starting {'dry run' if self.dry_run else 'processing'} in {self.vault} (LOD folder: {self.lod_dir})",
        )
        if self.dry_run:
            self.prepare_run()
        else:
            with tempfile.TemporaryDirectory(prefix="canvas-lod-") as directory:
                self.staging = Path(directory)
                self.log(MessageType.DETAIL, f"Staging in temporary directory: {self.staging}")
                try:
                    self.prepare_run()
                finally:
                    self.staging = None
        s = self.stats
        self.log(
            MessageType.ERROR if s.failed else MessageType.SUCCESS,
            f"Done.  canvases={s.scanned}  rewritten={s.changed}  variants={s.generated}  "
            f"reused={s.reused}  skipped={s.skipped}  errors={s.failed}",
        )
        return s

    def prepare_run(self) -> None:
        self.load_manifests()
        canvases = self.canvases()
        self.log(MessageType.INFO, f"Found {len(canvases)} canvas file(s)")
        snapshots = []
        for path in canvases:
            try:
                snapshot = self.read_canvas(path)
                if snapshot is not None:
                    snapshots.append(snapshot)
            except (OSError, ValueError) as exc:
                self.error(path.relative_to(self.vault).as_posix(), exc)
        try:
            self.prepare_images(snapshots)
        except (OSError, ValueError, BrokenProcessPool) as exc:
            self.error("image preparation", exc)
            self.log(MessageType.ERROR, "Preparation failed. No staged changes applied.")
            return
        for snapshot in snapshots:
            try:
                self.process_canvas(snapshot)
            except (OSError, ValueError) as exc:
                self.error(snapshot.path.relative_to(self.vault).as_posix(), exc)
        if self.stats.failed:
            self.log(MessageType.ERROR, "Preparation failed. No staged changes applied.")
            return
        if self.dry_run:
            self.stats.changed = len(self.canvas_updates)
            return
        try:
            self.validate_prepared(snapshots)
        except (OSError, ValueError) as exc:
            self.error("validation", exc)
            self.log(MessageType.ERROR, "Validation failed. No staged changes applied.")
            return
        try:
            self.apply_prepared()
        except (OSError, ValueError) as exc:
            self.error("applying staged output", exc)
