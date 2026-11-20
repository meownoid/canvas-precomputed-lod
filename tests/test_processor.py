from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from obsidian_prepare_lods import processor as lod
from obsidian_prepare_lods.terminal import MessageType


class ProcessorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.vault = Path(self.temp.name)
        self.messages: list[tuple[MessageType, str]] = []

    def record_log(self, kind: MessageType, message: str) -> None:
        self.messages.append((kind, message))

    def image(self, name="attachments/photo.png", size=(2400, 1200), mode="RGB", color=None, **save):
        path = self.vault / name
        path.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new(mode, size, color or ((30, 80, 140, 0) if mode == "RGBA" else (30, 80, 140)))
        image.save(path, **save)
        image.close()
        return path

    def canvas(self, name="Boards/Board.canvas", files=None):
        files = files or ["attachments/photo.png"]
        raw = {
            "nodes": [
                {
                    "id": str(i),
                    "type": "file",
                    "file": file,
                    "x": -15,
                    "y": 60,
                    "width": 800,
                    "height": 400,
                    "extension": {"untouched": True},
                }
                for i, file in enumerate(files)
            ],
            "edges": [{"id": "edge", "fromNode": "0", "toNode": "0", "label": "Keep me"}],
            "unknown": {"unicode": "雨 / ä", "array": [None, True, 1.25]},
        }
        path = self.vault / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(lod.json_bytes(raw, "\t"))
        return path

    def processor(self, vault=None, **options):
        # Keep the existing encoding/recovery fixtures small; filter tests use the production limits.
        options.setdefault("min_canvas_bytes", 0)
        options.setdefault("min_image_bytes", 0)
        options.setdefault("log", self.record_log)
        return lod.Processor(vault or self.vault, **options)

    def run_processor(self, **options):
        processor = self.processor(**options)
        stats = processor.run()
        return processor, stats

    def sized_file(self, name, size):
        path = self.vault / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a+b") as stream:
            stream.truncate(size)
        return path

    def manifest(self, name="Boards/Board.canvas", folder="attachments/lod"):
        return json.loads((self.vault / folder / "canvases" / name / "lod.json").read_text())

    def snapshot(self):
        return {
            p.relative_to(self.vault).as_posix(): (p.read_bytes(), p.stat().st_mtime_ns)
            for p in self.vault.rglob("*")
            if p.is_file()
        }

    def test_new_boards_require_strictly_more_than_16_mib_of_attachments(self):
        originals = {}
        for offset in (-1, 0, 1):
            image = self.image(f"{offset}.png", size=(80, 40))
            self.sized_file(image.name, lod.MIN_IMAGE_BYTES + 1)
            attachment = f"{offset}.pdf"
            self.sized_file(attachment, lod.MIN_CANVAS_BYTES + offset - image.stat().st_size)
            canvas = self.canvas(f"{offset}.canvas", [image.name, attachment])
            originals[offset] = (canvas, canvas.read_bytes())
        dry_run = lod.Processor(self.vault, settings=lod.Settings((8, 16, 32)), dry_run=True, log=self.record_log).run()
        self.assertEqual((dry_run.generated, dry_run.changed, dry_run.failed), (3, 1, 0))
        self.assertIn(
            (MessageType.SKIP, "0.canvas: attachments total 16 MiB is not greater than 16 MiB"), self.messages
        )
        self.assertTrue(all(canvas.read_bytes() == initial for canvas, initial in originals.values()))
        self.assertFalse((self.vault / "attachments/lod").exists())
        self.assertFalse((self.vault / ".canvas-lod-backups").exists())
        processor = lod.Processor(self.vault, settings=lod.Settings((8, 16, 32)), log=self.record_log)
        stats = processor.run()
        self.assertEqual((stats.scanned, stats.generated, stats.changed, stats.failed), (3, 3, 1, 0))
        for offset, (canvas, initial) in originals.items():
            self.assertEqual(canvas.read_bytes() == initial, offset <= 0)
            self.assertEqual((self.vault / processor.manifest_relative(canvas.name)).exists(), offset > 0)

    def test_repeated_attachments_count_once_and_small_boards_prepare_no_images(self):
        self.image(size=(80, 40))
        self.sized_file("attachments/photo.png", lod.MIN_IMAGE_BYTES + 1)
        self.sized_file("large.pdf", lod.MIN_CANVAS_BYTES // 2)
        canvas = self.canvas(files=["large.pdf", "large.pdf", "attachments/photo.png", "attachments/photo.png"])
        initial = canvas.read_bytes()
        processor = lod.Processor(self.vault, workers=2, log=self.record_log)
        with patch.object(processor, "prepare", side_effect=AssertionError("board should be skipped")):
            stats = processor.run()
        self.assertEqual((stats.generated, stats.changed, stats.skipped, stats.failed), (0, 0, 1, 0))
        self.assertEqual(canvas.read_bytes(), initial)
        self.assertFalse(processor.prepared)
        self.assertFalse((self.vault / "attachments/lod").exists())

    def test_image_size_filter_is_strict_and_matches_in_serial_and_parallel(self):
        files = ["below.png", "equal.png", "above.png"]
        for name, offset in zip(files, (-1, 0, 1), strict=True):
            if offset >= 0:
                self.image(name, size=(80, 40))
            # A small corrupt file must be skipped before Pillow tries to decode it.
            self.sized_file(name, lod.MIN_IMAGE_BYTES + offset)
        self.sized_file("large.pdf", lod.MIN_CANVAS_BYTES)
        canvas = self.canvas(files=[*files, "below.png", "large.pdf"])
        for workers in (1, 2):
            with self.subTest(workers=workers):
                self.messages.clear()
                processor = lod.Processor(
                    self.vault, settings=lod.Settings((8, 16, 32)), workers=workers, log=self.record_log
                )
                stats = processor.run()
                self.assertEqual((stats.failed, stats.skipped), (0, 3))
                self.assertIn((MessageType.SKIP, "below.png: file size is not greater than 512 KiB"), self.messages)
                self.assertIn((MessageType.SKIP, "equal.png: file size is not greater than 512 KiB"), self.messages)
                self.assertEqual((stats.generated, stats.changed), (3, 1) if workers == 1 else (0, 0))
                nodes = json.loads(canvas.read_bytes())["nodes"]
                self.assertEqual([nodes[i]["file"] for i in (0, 1, 3)], ["below.png", "equal.png", "below.png"])
                self.assertNotEqual(nodes[2]["file"], "above.png")
                self.assertEqual(len(self.manifest()["assets"]), 1)

    def test_processed_board_stays_eligible_and_small_original_restores_direct_reference(self):
        self.image(size=(80, 40))
        canvas = self.canvas()
        self.run_processor(settings=lod.Settings((8, 16, 32)))
        self.image("new.png", size=(80, 40))
        self.sized_file("new.png", lod.MIN_IMAGE_BYTES + 1)
        raw = json.loads(canvas.read_bytes())
        raw["nodes"].append({"id": "new", "type": "file", "file": "new.png"})
        canvas.write_bytes(lod.json_bytes(raw))
        stats = lod.Processor(self.vault, settings=lod.Settings((8, 16, 32)), log=self.record_log).run()
        self.assertEqual((stats.generated, stats.changed, stats.failed), (3, 1, 0))
        nodes = json.loads(canvas.read_bytes())["nodes"]
        self.assertEqual(nodes[0]["file"], "attachments/photo.png")
        self.assertNotEqual(nodes[1]["file"], "new.png")
        self.assertEqual(len(self.manifest()["assets"]), 2)
        # Restoring a saved canvas does not remove its existing processing history.
        nodes[1]["file"] = "new.png"
        canvas.write_bytes(lod.json_bytes({"nodes": nodes}))
        stats = lod.Processor(self.vault, settings=lod.Settings((8, 16, 32)), log=self.record_log).run()
        self.assertEqual((stats.generated, stats.changed, stats.reused, stats.failed), (0, 1, 1, 0))

    def test_renamed_processed_board_stays_eligible_below_attachment_limit(self):
        self.image(size=(80, 40))
        self.sized_file("attachments/photo.png", lod.MIN_IMAGE_BYTES + 1)
        canvas = self.canvas()
        self.run_processor(settings=lod.Settings((8, 16, 32)))
        moved = self.vault / "Moved.canvas"
        canvas.rename(moved)
        initial = moved.read_bytes()
        stats = lod.Processor(self.vault, settings=lod.Settings((8, 16, 32)), log=self.record_log).run()
        self.assertEqual((stats.generated, stats.changed, stats.reused, stats.failed), (0, 0, 1, 0))
        self.assertEqual(moved.read_bytes(), initial)
        self.assertEqual(self.manifest("Moved.canvas")["canvas"], "Moved.canvas")

    def test_small_board_with_missing_provenance_still_reports_error(self):
        self.image(size=(80, 40))
        self.canvas()
        self.run_processor(settings=lod.Settings((8, 16, 32)))
        (self.vault / "attachments/lod/canvases/Boards/Board.canvas/lod.json").unlink()
        initial = self.snapshot()
        stats = lod.Processor(self.vault, log=self.record_log).run()
        self.assertEqual((stats.generated, stats.changed, stats.failed), (0, 0, 1))
        self.assertEqual(self.snapshot(), initial)

    def test_three_tiers_preserve_data_original_and_backup(self):
        original = self.image()
        original_bytes = original.read_bytes()
        canvas = self.canvas()
        initial = canvas.read_bytes()
        processor, stats = self.run_processor()
        self.assertEqual((stats.generated, stats.changed, stats.failed), (3, 1, 0))
        expected = json.loads(initial)
        manifest = self.manifest()
        asset_id, asset = next(iter(manifest["assets"].items()))
        self.assertEqual([variant["target"] for variant in asset["variants"]], [500, 1000, 2000])
        self.assertRegex(asset_id, r"^[0-9a-f]{32}$")
        self.assertRegex(asset["original"]["fingerprint"], r"^[0-9a-f]{32}$")
        expected["nodes"][0]["file"] = asset["variants"][0]["path"]
        self.assertEqual(json.loads(canvas.read_bytes()), expected)
        self.assertIn(b'\n\t"nodes"', canvas.read_bytes())
        self.assertEqual(original.read_bytes(), original_bytes)
        backups = list((self.vault / ".canvas-lod-backups").rglob("*.canvas"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), initial)
        self.assertEqual(lod.Manifest.parse(manifest, processor.lod_dir).to_json(), manifest)

    def test_manifest_rejects_invalid_hashes_and_changed_provenance(self):
        self.image(size=(80, 40))
        self.canvas()
        processor, _ = self.run_processor(settings=lod.Settings((8, 16, 32)))
        manifest = self.manifest()
        asset_id = next(iter(manifest["assets"]))
        for invalid in ["a" * 31, "a" * 33, "a" * 64, "g" * 32, "A" * 32]:
            with self.subTest(fingerprint=invalid):
                raw = deepcopy(manifest)
                raw["assets"][asset_id]["original"]["fingerprint"] = invalid
                with self.assertRaisesRegex(lod.ProcessingError, "invalid source fingerprint"):
                    lod.Manifest.parse(raw, processor.lod_dir)
            with self.subTest(asset_id=invalid):
                raw = deepcopy(manifest)
                raw["assets"][invalid] = raw["assets"].pop(asset_id)
                with self.assertRaisesRegex(lod.ProcessingError, "invalid asset ID"):
                    lod.Manifest.parse(raw, processor.lod_dir)
        manifest["assets"][asset_id]["original"]["fingerprint"] = "0" * 32
        with self.assertRaisesRegex(lod.ProcessingError, "asset ID does not match its provenance"):
            lod.Manifest.parse(manifest, processor.lod_dir)

    def test_omits_equal_and_larger_targets(self):
        self.image(size=(1500, 750))
        self.canvas()
        _, stats = self.run_processor()
        variants = next(iter(self.manifest()["assets"].values()))["variants"]
        self.assertEqual([v["target"] for v in variants], [500, 1000])
        self.assertEqual(stats.generated, 2)

    def test_exact_target_does_not_generate_equal_size(self):
        self.image(size=(1000, 500))
        self.canvas()
        self.run_processor()
        self.assertEqual([v["target"] for v in next(iter(self.manifest()["assets"].values()))["variants"]], [500])

    def test_small_images_are_unchanged_without_manifest(self):
        self.image(size=(500, 250))
        self.canvas()
        initial = self.snapshot()
        _, stats = self.run_processor()
        self.assertEqual((stats.generated, stats.changed), (0, 0))
        self.assertEqual(self.snapshot(), initial)

    def test_repeat_run_performs_zero_writes(self):
        self.image()
        self.canvas()
        self.run_processor()
        initial = self.snapshot()
        with patch.object(lod, "atomic_write", side_effect=AssertionError("unexpected write")):
            _, stats = self.run_processor()
        self.assertEqual((stats.generated, stats.changed, stats.failed), (0, 0, 0))
        self.assertEqual(self.snapshot(), initial)

    def test_dry_run_performs_zero_writes(self):
        self.image()
        self.canvas()
        initial = self.snapshot()
        with patch.object(lod, "atomic_write", side_effect=AssertionError("unexpected write")):
            _, stats = self.run_processor(dry_run=True)
        self.assertEqual((stats.generated, stats.changed), (3, 1))
        self.assertEqual(self.snapshot(), initial)

    def test_shared_original_and_equal_basenames(self):
        self.image("one/photo.png")
        self.image("two/photo.png")
        self.canvas("A/Board.canvas", ["one/photo.png", "two/photo.png"])
        self.canvas("B/Board.canvas", ["one/photo.png"])
        _, stats = self.run_processor()
        a, b = self.manifest("A/Board.canvas"), self.manifest("B/Board.canvas")
        self.assertEqual(len(a["assets"]), 2)
        self.assertEqual(len(b["assets"]), 1)
        self.assertEqual(stats.generated, 6)
        self.assertTrue(set(b["assets"]).issubset(a["assets"]))

    def test_parallel_matches_serial_and_reuses_shared_images(self):
        self.image("one/photo.png", size=(80, 40), mode="RGBA")
        self.image("two/photo.png", size=(40, 80))
        self.canvas("A/Board.canvas", ["one/photo.png", "one/photo.png"])
        self.canvas("B/Board.canvas", ["one/photo.png", "two/photo.png"])
        settings = lod.Settings((8, 16, 32))
        with tempfile.TemporaryDirectory() as directory:
            serial_vault = Path(directory)
            shutil.copytree(self.vault, serial_vault, dirs_exist_ok=True)
            serial = self.processor(serial_vault, settings=settings, workers=1, log=lambda _kind, _message: None)
            serial_stats = serial.run()
            _, parallel_stats = self.run_processor(settings=settings, workers=2)
            self.assertEqual(parallel_stats, serial_stats)
            self.assertEqual((parallel_stats.generated, parallel_stats.changed, parallel_stats.failed), (6, 2, 0))
            serial_files = {
                path.relative_to(serial_vault).as_posix(): path.read_bytes()
                for path in serial_vault.rglob("*")
                if path.is_file() and ".canvas-lod-backups" not in path.parts
            }
            self.assertEqual(
                {name: content for name, (content, _) in self.snapshot().items() if not name.startswith(".")},
                serial_files,
            )
            for backup in (self.vault / ".canvas-lod-backups").rglob("*.canvas"):
                relative = Path(*backup.relative_to(self.vault / ".canvas-lod-backups").parts[1:])
                self.assertEqual(
                    backup.read_bytes(), (serial_vault / ".canvas-lod-backups" / serial.run_id / relative).read_bytes()
                )
        self.assertEqual(self.messages.count((MessageType.DETAIL, "Checking one/photo.png")), 1)
        initial = self.snapshot()
        _, stats = self.run_processor(settings=settings, workers=2)
        self.assertEqual((stats.generated, stats.changed, stats.reused, stats.failed), (0, 0, 2, 0))
        self.assertEqual(self.snapshot(), initial)

    def test_parallel_dry_run_performs_zero_writes(self):
        self.image("one.png", size=(80, 40))
        self.image("two.png", size=(40, 80))
        self.canvas("One.canvas", ["one.png"])
        self.canvas("Two.canvas", ["two.png"])
        initial = self.snapshot()
        _, stats = self.run_processor(settings=lod.Settings((8, 16, 32)), workers=2, dry_run=True)
        self.assertEqual((stats.generated, stats.changed, stats.failed), (6, 2, 0))
        self.assertEqual(self.snapshot(), initial)

    def test_parallel_failures_discard_all_staged_changes(self):
        self.image("photo.png", size=(80, 40))
        self.image("small.png", size=(8, 4))
        (self.vault / "corrupt.png").write_bytes(b"not an image")
        frames = [Image.new("RGB", (40, 40), color) for color in ["red", "blue"]]
        frames[0].save(self.vault / "animated.gif", save_all=True, append_images=frames[1:], duration=100)
        for frame in frames:
            frame.close()
        files = ["corrupt.png", "missing.png", "missing.png", "animated.gif", "small.png", "photo.png"]
        canvas = self.canvas(files=files)
        initial = self.snapshot()
        _, stats = self.run_processor(settings=lod.Settings((8, 16, 32)), workers=2)
        self.assertEqual((stats.generated, stats.changed, stats.failed, stats.skipped), (3, 0, 3, 1))
        nodes = json.loads(canvas.read_text())["nodes"]
        self.assertEqual([node["file"] for node in nodes], files)
        self.assertEqual(self.snapshot(), initial)

    def test_edit_during_parallel_preparation_is_not_overwritten(self):
        self.image("one.png", size=(80, 40))
        self.image("two.png", size=(40, 80))
        canvas = self.canvas(files=["one.png", "two.png"])
        edited = b'{"nodes":[],"edited":true}'

        def log(kind: MessageType, message: str) -> None:
            if kind is MessageType.SUCCESS and message.startswith("Finished preparing "):
                canvas.write_bytes(edited)

        processor = self.processor(settings=lod.Settings((8, 16, 32)), workers=2, log=log)
        stats = processor.run()
        self.assertEqual((stats.generated, stats.changed, stats.failed), (6, 0, 1))
        self.assertEqual(canvas.read_bytes(), edited)
        self.assertFalse((self.vault / ".canvas-lod-backups").exists())
        self.assertFalse((self.vault / "attachments/lod").exists())

    def test_everything_is_staged_before_dependencies_and_canvases_are_applied(self):
        for workers in [1, 2]:
            with self.subTest(workers=workers), tempfile.TemporaryDirectory() as directory:
                vault = Path(directory).resolve()
                self.image("one.png", size=(80, 40))
                self.image("two.png", size=(40, 80))
                self.canvas("One.canvas", ["one.png"])
                self.canvas("Two.canvas", ["two.png"])
                shutil.copytree(self.vault, vault, dirs_exist_ok=True)
                initial = {p.relative_to(vault): p.read_bytes() for p in vault.rglob("*") if p.is_file()}
                staged = []
                applied = []

                def log(kind: MessageType, message: str) -> None:
                    if kind is MessageType.INFO and message.startswith("Staged "):
                        staged.append(message)
                        self.assertEqual(
                            {p.relative_to(vault): p.read_bytes() for p in vault.rglob("*") if p.is_file()}, initial
                        )

                processor = self.processor(vault, settings=lod.Settings((8, 16, 32)), workers=workers, log=log)
                write = lod.atomic_write

                def checked_write(path, data, before_replace=None):
                    if path.is_relative_to(vault):
                        self.assertEqual(len(staged), 2)
                        applied.append(path)
                        if path.parent == vault and path.suffix == ".canvas":
                            self.assertEqual(len(list((vault / "attachments/lod/assets").rglob("*.webp"))), 6)
                            self.assertEqual(len(list((vault / "attachments/lod/canvases").rglob("lod.json"))), 2)
                            for name in ["One.canvas", "Two.canvas"]:
                                backup = vault / ".canvas-lod-backups" / processor.run_id / name
                                self.assertEqual(backup.read_bytes(), initial[Path(name)])
                    write(path, data, before_replace)

                with patch.object(lod, "atomic_write", side_effect=checked_write):
                    stats = processor.run()
                self.assertEqual((stats.generated, stats.changed, stats.failed), (6, 2, 0))
                self.assertEqual([p.name for p in applied[-2:]], ["One.canvas", "Two.canvas"])

    def test_staging_write_failure_leaves_vault_unchanged_and_cleans_temp_directory(self):
        self.image(size=(80, 40))
        self.canvas()
        initial = self.snapshot()
        temporary_outputs = []
        write = lod.atomic_write

        def failing_write(path, data, before_replace=None):
            temporary_outputs.append(path)
            self.assertFalse(path.is_relative_to(self.vault))
            if path.name == "16.webp":
                raise OSError("simulated full temporary disk")
            write(path, data, before_replace)

        with patch.object(lod, "atomic_write", side_effect=failing_write):
            _, stats = self.run_processor(settings=lod.Settings((8, 16, 32)), workers=1)
        self.assertEqual((stats.generated, stats.changed, stats.failed), (1, 0, 1))
        self.assertEqual(self.snapshot(), initial)
        self.assertTrue(temporary_outputs)
        self.assertTrue(all(not path.parent.exists() for path in temporary_outputs))

    def test_invalid_staged_variant_aborts_before_vault_writes(self):
        self.image(size=(80, 40))
        self.canvas()
        initial = self.snapshot()
        write = lod.atomic_write

        def corrupt_write(path, data, before_replace=None):
            write(path, b"invalid image" if path.name == "16.webp" else data, before_replace)

        with patch.object(lod, "atomic_write", side_effect=corrupt_write):
            _, stats = self.run_processor(settings=lod.Settings((8, 16, 32)), workers=1)
        self.assertEqual((stats.generated, stats.changed, stats.failed), (3, 0, 1))
        self.assertEqual(self.snapshot(), initial)
        self.assertTrue(
            any(
                kind is MessageType.ERROR and "prepared variant is missing or invalid" in message
                for kind, message in self.messages
            )
        )

    def test_edit_to_later_canvas_aborts_entire_apply(self):
        self.image(size=(80, 40))
        first = self.canvas("One.canvas")
        second = self.canvas("Two.canvas")
        initial_first = first.read_bytes()
        edited = b'{"nodes":[],"edited":true}'

        def log(kind: MessageType, message: str) -> None:
            if kind is MessageType.INFO and message == "Staged Two.canvas":
                second.write_bytes(edited)

        processor = self.processor(settings=lod.Settings((8, 16, 32)), workers=1, log=log)
        stats = processor.run()
        self.assertEqual((stats.generated, stats.changed, stats.failed), (3, 0, 1))
        self.assertEqual(first.read_bytes(), initial_first)
        self.assertEqual(second.read_bytes(), edited)
        self.assertFalse((self.vault / "attachments/lod").exists())
        self.assertFalse((self.vault / ".canvas-lod-backups").exists())

    def test_changed_original_aborts_before_apply(self):
        self.image(size=(80, 40))
        canvas = self.canvas()
        initial_canvas = canvas.read_bytes()

        def log(kind: MessageType, message: str) -> None:
            if kind is MessageType.INFO and message.startswith("Staged "):
                self.image(size=(80, 40), color=(200, 20, 20))

        processor = self.processor(settings=lod.Settings((8, 16, 32)), workers=1, log=log)
        stats = processor.run()
        self.assertEqual((stats.generated, stats.changed, stats.failed), (3, 0, 1))
        self.assertEqual(canvas.read_bytes(), initial_canvas)
        self.assertFalse((self.vault / "attachments/lod").exists())

    def test_manifest_apply_failure_keeps_all_canvas_references_unchanged(self):
        self.image(size=(80, 40))
        canvases = [self.canvas("One.canvas"), self.canvas("Two.canvas")]
        initial = [p.read_bytes() for p in canvases]
        write = lod.atomic_write

        def failing_write(path, data, before_replace=None):
            if path.is_relative_to(self.vault.resolve()) and path.name == "lod.json":
                raise OSError("simulated manifest apply failure")
            write(path, data, before_replace)

        with patch.object(lod, "atomic_write", side_effect=failing_write):
            _, stats = self.run_processor(settings=lod.Settings((8, 16, 32)), workers=1)
        self.assertEqual((stats.changed, stats.failed), (0, 1))
        self.assertEqual([p.read_bytes() for p in canvases], initial)
        self.assertFalse((self.vault / ".canvas-lod-backups").exists())
        _, stats = self.run_processor(settings=lod.Settings((8, 16, 32)), workers=1)
        self.assertEqual((stats.changed, stats.failed), (2, 0))

    def test_workers_cli_runs_spawned_processes_and_rejects_zero(self):
        self.image("one.png", size=(80, 40))
        self.image("two.png", size=(40, 80))
        self.canvas(files=["one.png", "two.png"])
        for name in ("one.png", "two.png"):
            self.sized_file(name, lod.MIN_CANVAS_BYTES // 2 + 1)
        command = [sys.executable, "-m", "obsidian_prepare_lods", str(self.vault)]
        result = subprocess.run(
            command + ["--workers", "2", "--sizes", "8,16,32"], cwd=self.vault, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("with 2 worker processes", result.stdout)
        self.assertIn("variants=6", result.stdout)
        initial = self.snapshot()
        result = subprocess.run(command + ["--workers", "0"], cwd=self.vault, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("workers must be a positive integer", result.stderr)
        self.assertEqual(self.snapshot(), initial)

    def test_changed_original_and_new_card(self):
        self.image()
        canvas = self.canvas()
        self.run_processor()
        old = self.manifest()
        self.image(size=(1800, 900), color=(200, 20, 20))
        self.image("attachments/new.png", (1000, 1000))
        raw = json.loads(canvas.read_text())
        raw["nodes"].append({"id": "new", "type": "file", "file": "attachments/new.png"})
        canvas.write_bytes(lod.json_bytes(raw))
        _, stats = self.run_processor()
        new = self.manifest()
        self.assertEqual(stats.changed, 1)
        self.assertEqual(len(new["assets"]), 3)
        self.assertTrue(set(old["assets"]).issubset(new["assets"]))
        self.assertNotEqual(json.loads(canvas.read_text())["nodes"][0]["file"], raw["nodes"][0]["file"])

    def test_shrinking_original_restores_direct_reference(self):
        self.image()
        canvas = self.canvas()
        self.run_processor()
        self.image(size=(200, 100))
        _, stats = self.run_processor()
        self.assertEqual(stats.changed, 1)
        self.assertEqual(json.loads(canvas.read_text())["nodes"][0]["file"], "attachments/photo.png")
        self.assertEqual(len(self.manifest()["assets"]), 1)

    def test_missing_variant_is_repaired_without_canvas_write(self):
        self.image()
        self.canvas()
        self.run_processor()
        asset = next(iter(self.manifest()["assets"].values()))
        missing = self.vault / asset["variants"][1]["path"]
        missing.unlink()
        _, stats = self.run_processor()
        self.assertEqual((stats.generated, stats.changed), (1, 0))
        self.assertTrue(missing.exists())

    def test_corrupt_webp_payload_is_repaired_without_canvas_write(self):
        self.image(size=(1200, 600), color=(255, 0, 0))
        canvas = self.canvas()
        self.run_processor()
        initial = canvas.read_bytes()
        variant = next(iter(self.manifest()["assets"].values()))["variants"][0]
        path = self.vault / variant["path"]
        data = path.read_bytes()
        path.write_bytes(data[:30] + bytes(len(data) - 30))
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image, self.assertRaises(OSError):
            image.load()

        _, stats = self.run_processor()

        self.assertEqual((stats.generated, stats.changed, stats.failed), (1, 0, 0))
        self.assertEqual(canvas.read_bytes(), initial)
        with Image.open(path) as image:
            image.load()
            self.assertEqual(image.size, (variant["width"], variant["height"]))

    def test_animated_replacements_restore_original_in_serial_and_parallel(self):
        for workers in (1, 2):
            with self.subTest(workers=workers):
                folder = f"workers-{workers}"
                vault = self.vault / folder
                original = self.image(f"{folder}/photo.png", size=(1200, 600), compress_level=0)
                self.image(f"{folder}/other.png", size=(1200, 600), compress_level=0)
                canvas = self.canvas(f"{folder}/Board.canvas", ["photo.png", "other.png"])
                self.processor(vault, workers=workers, min_image_bytes=lod.MIN_IMAGE_BYTES).run()
                saved = canvas.read_bytes()
                frames = [Image.new("RGB", (1200, 600), color) for color in ("blue", "green")]
                try:
                    frames[0].save(original, save_all=True, append_images=frames[1:], duration=100, compress_level=0)
                finally:
                    for frame in frames:
                        frame.close()
                self.assertGreater(original.stat().st_size, lod.MIN_IMAGE_BYTES)
                before = self.snapshot()
                preview = self.processor(vault, workers=workers, dry_run=True).run()
                self.assertEqual((preview.changed, preview.failed), (1, 0))
                self.assertEqual(self.snapshot(), before)

                processor = self.processor(vault, workers=workers, min_image_bytes=lod.MIN_IMAGE_BYTES)
                stats = processor.run()

                self.assertEqual((stats.changed, stats.failed), (1, 0))
                self.assertEqual(json.loads(canvas.read_text())["nodes"][0]["file"], "photo.png")
                backup = vault / ".canvas-lod-backups" / processor.run_id / "Board.canvas"
                self.assertEqual(backup.read_bytes(), saved)
                with Image.open(original) as image:
                    self.assertEqual(getattr(image, "n_frames", 1), 2)

    def test_renamed_canvas_recovers_existing_provenance(self):
        self.image()
        canvas = self.canvas()
        self.run_processor()
        dest = self.vault / "Moved.canvas"
        canvas.rename(dest)
        initial = dest.read_bytes()
        _, stats = self.run_processor()
        self.assertEqual((stats.generated, stats.changed, stats.failed), (0, 0, 0))
        self.assertEqual(self.manifest("Moved.canvas")["canvas"], "Moved.canvas")
        self.assertEqual(dest.read_bytes(), initial)

    def test_transparency_preserved(self):
        self.image(mode="RGBA")
        self.canvas()
        self.run_processor()
        variant = next(iter(self.manifest()["assets"].values()))["variants"][0]
        with Image.open(self.vault / variant["path"]) as image:
            pixel = image.getpixel((0, 0))
            assert isinstance(pixel, tuple)
            self.assertEqual(pixel[3], 0)

    def test_exif_orientation_applied(self):
        exif = Image.Exif()
        exif[274] = 6
        self.image("attachments/rotated.jpg", (1200, 600), exif=exif)
        self.canvas(files=["attachments/rotated.jpg"])
        self.run_processor()
        asset = next(iter(self.manifest()["assets"].values()))
        self.assertEqual((asset["original"]["width"], asset["original"]["height"]), (600, 1200))
        self.assertEqual((asset["variants"][0]["width"], asset["variants"][0]["height"]), (250, 500))

    def test_unsupported_and_animated_images_unchanged(self):
        self.image()
        frames = [Image.new("RGB", (500, 500), color) for color in ["red", "blue"]]
        path = self.vault / "attachments/animated.gif"
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=100)
        for frame in frames:
            frame.close()
        (self.vault / "attachments/vector.svg").write_text("<svg/>")
        canvas = self.canvas(files=["attachments/animated.gif", "attachments/vector.svg"])
        initial = canvas.read_bytes()
        _, stats = self.run_processor()
        self.assertEqual((stats.changed, stats.skipped, stats.failed), (0, 2, 0))
        self.assertEqual(canvas.read_bytes(), initial)

    def test_corrupt_and_missing_images_abort_all_vault_changes(self):
        self.image()
        (self.vault / "attachments/corrupt.png").write_bytes(b"not an image")
        canvas = self.canvas(files=["attachments/corrupt.png", "attachments/missing.png", "attachments/photo.png"])
        initial = self.snapshot()
        _, stats = self.run_processor()
        self.assertEqual((stats.changed, stats.failed), (0, 2))
        self.assertEqual(json.loads(canvas.read_text())["nodes"][0]["file"], "attachments/corrupt.png")
        self.assertEqual(self.snapshot(), initial)

    def test_missing_original_preserves_existing_preview(self):
        original = self.image()
        self.canvas()
        self.run_processor()
        original.unlink()
        initial = self.snapshot()
        _, stats = self.run_processor()
        self.assertEqual(stats.failed, 1)
        self.assertEqual(self.snapshot(), initial)

    def test_invalid_manifest_is_not_overwritten(self):
        self.image()
        self.canvas()
        self.run_processor()
        path = self.vault / "attachments/lod/canvases/Boards/Board.canvas/lod.json"
        path.write_text('{"version":999}')
        initial = self.snapshot()
        _, stats = self.run_processor()
        self.assertGreater(stats.failed, 0)
        self.assertEqual(self.snapshot(), initial)

    def test_missing_manifest_never_processes_generated_image(self):
        self.image()
        self.canvas()
        self.run_processor()
        (self.vault / "attachments/lod/canvases/Boards/Board.canvas/lod.json").unlink()
        initial = self.snapshot()
        _, stats = self.run_processor()
        self.assertEqual(stats.failed, 1)
        self.assertEqual(self.snapshot(), initial)

    def test_wrong_output_folder_cannot_cause_recursive_processing(self):
        self.image()
        self.canvas()
        self.run_processor()
        initial = self.snapshot()
        _, stats = self.run_processor(lod_dir="Other/LOD")
        self.assertEqual(stats.failed, 1)
        self.assertEqual(self.snapshot(), initial)

    def test_remote_file_reference_is_skipped(self):
        canvas = self.canvas(files=["https://example.invalid/image.png"])
        initial = canvas.read_bytes()
        _, stats = self.run_processor()
        self.assertEqual((stats.failed, stats.skipped), (0, 1))
        self.assertEqual(canvas.read_bytes(), initial)

    def test_custom_folder_and_settings(self):
        self.image(size=(1000, 500))
        self.canvas()
        self.run_processor(lod_dir="Media/LOD", settings=lod.Settings((100, 200, 400), 70))
        manifest = self.manifest(folder="Media/LOD")
        self.assertEqual(next(iter(manifest["assets"].values()))["settings"]["sizes"], [100, 200, 400])

    def test_hidden_backups_and_generated_canvases_are_not_scanned(self):
        self.image()
        self.canvas()
        self.canvas(".trash/Hidden.canvas")
        self.canvas("attachments/lod/Fake.canvas")
        self.run_processor()
        _, stats = self.run_processor()
        self.assertEqual(stats.scanned, 1)

    def test_concurrent_edit_is_not_overwritten(self):
        self.image()
        canvas = self.canvas()
        processor = self.processor()
        prepare = processor.prepare

        def racing_prepare(original):
            result = prepare(original)
            canvas.write_text('{"nodes":[],"edited":true}')
            return result

        with patch.object(processor, "prepare", side_effect=racing_prepare):
            stats = processor.run()
        self.assertEqual(stats.failed, 1)
        self.assertEqual(json.loads(canvas.read_text()), {"nodes": [], "edited": True})

    def test_atomic_write_failure_keeps_old_file(self):
        path = self.vault / "test.json"
        path.write_bytes(b"old")

        def reject():
            raise lod.ProcessingError("changed")

        with self.assertRaises(lod.ProcessingError):
            lod.atomic_write(path, b"new", reject)
        self.assertEqual(path.read_bytes(), b"old")
        self.assertEqual(list(self.vault.glob(".lod-tmp-*")), [])

    def test_unsafe_paths_and_settings_rejected(self):
        for path in ["../escape", "/absolute", "x/../y", "x\\y", "https://host/image.png", ""]:
            with self.subTest(path=path), self.assertRaises(lod.ProcessingError):
                lod.vault_path(path)
        for sizes in [(1, 2), (256, 256, 768), (768, 256, 1600), (256, 768, 20000)]:
            with self.subTest(sizes=sizes), self.assertRaises(lod.ProcessingError):
                lod.Settings(sizes)
        for workers in [0, -1, True, 1.5]:
            with self.subTest(workers=workers), self.assertRaises(lod.ProcessingError):
                lod.Processor(self.vault, workers=workers)
        for option in ("min_canvas_bytes", "min_image_bytes"):
            for value in (-1, True, 1.5):
                with self.subTest(option=option, value=value), self.assertRaises(lod.ProcessingError):
                    self.processor(**{option: value})

    def test_symlink_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as outside:
            (self.vault / "escape").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(lod.ProcessingError):
                lod.Processor(self.vault, lod_dir="escape/lod")


if __name__ == "__main__":
    unittest.main()
